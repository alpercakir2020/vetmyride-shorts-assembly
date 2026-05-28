// Format A (Roast) video assembly. Reads:
//   • tmp/row.json                 — script + format metadata
//   • tmp/slides/slide-{1..5}.jpg  — 1080×1920 Satori slides
//   • tmp/narration.mp3            — Google TTS output
//   • tmp/word-timestamps.json     — per-word timing
//   • tmp/karaoke.ass              — burned-in karaoke captions
//   • assets/sfx/*.wav             — per-beat SFX
//   • assets/music/bed-*.mp3       — background bed (random per video)
//
// Outputs:
//   • tmp/video.mp4         — 1080×1920 H.264 CRF 23 faststart
//   • tmp/duration.txt      — total duration in seconds (for patch-row)
//
// Strategy:
//   1. Compute per-beat slide durations from beat.duration_sec, snapping
//      cut points to the nearest music-cue beat for that track.
//   2. Build a video filter graph that holds each slide for its duration
//      with a subtle ken-burns zoom (1.0 → 1.08 over the beat).
//   3. Mix audio: TTS narration full level + music bed at -18dB, ducked
//      another -6dB during the CATCH beat. SFX layered on the beat's start.
//   4. Burn karaoke ASS subs via libass.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pickTrack, snapToBeat } from "./music-cues.mjs";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const assetsDir = path.join(cwd, "assets");

const row = JSON.parse(fs.readFileSync(path.join(tmpDir, "row.json"), "utf8"));
const wts = JSON.parse(
  fs.readFileSync(path.join(tmpDir, "word-timestamps.json"), "utf8"),
);
const beats = row.script_json?.beats ?? [];
if (beats.length !== 5) {
  console.error(`expected 5 beats, got ${beats.length}`);
  process.exit(1);
}

// ── Beat timings ────────────────────────────────────────────────────────────
//
// Trust the actual TTS timing (word-timestamps end_sec) over the LLM's
// nominal duration_sec — the actual MP3 is the authoritative truth.

const track = pickTrack(row.id);
const beatTimings = [];
let prevEnd = 0;
for (let i = 0; i < beats.length; i++) {
  const beat = beats[i];
  const wtsBeat = wts.per_beat[i];
  const start = prevEnd;
  // end_sec is from the TTS markName at the end of the beat
  const nominalEnd =
    wtsBeat?.end_sec ??
    wtsBeat?.words?.[wtsBeat.words.length - 1]?.time_sec + 0.4 ??
    start + (beat.duration_sec ?? 6);
  // Snap to nearest beat cue (within a 0.3s window so we don't over-warp)
  const snapped = snapToBeat(track, nominalEnd);
  const end =
    Math.abs(snapped - nominalEnd) < 0.3 ? snapped : nominalEnd;
  beatTimings.push({ id: beat.id, start, end, duration: end - start, beat });
  prevEnd = end;
}
const totalDuration = prevEnd;
console.log(`Total duration: ${totalDuration.toFixed(2)}s using track ${track.file}`);

// ── Build slide concat input ────────────────────────────────────────────────

const concatList = path.join(tmpDir, "concat.txt");
const lines = beatTimings.map(
  (t, i) =>
    `file '${path.join(tmpDir, "slides", `slide-${i + 1}.jpg`)}'\nduration ${t.duration.toFixed(3)}`,
);
// Last file repeated without duration to anchor end
lines.push(`file '${path.join(tmpDir, "slides", `slide-${beats.length}.jpg`)}'`);
fs.writeFileSync(concatList, lines.join("\n"));

// ── SFX cue list ────────────────────────────────────────────────────────────

const sfxCues = [];
for (const t of beatTimings) {
  const sfx = t.beat.sfx;
  if (!sfx) continue;
  const sfxPath = path.join(assetsDir, "sfx", `${sfx}.wav`);
  if (!fs.existsSync(sfxPath)) {
    console.warn(`  ⚠ SFX file missing, skipping: ${sfxPath}`);
    continue;
  }
  sfxCues.push({ path: sfxPath, at: t.start });
}

// ── Music bed: duck -6dB during CATCH beat ──────────────────────────────────

const catchTiming = beatTimings.find((t) => t.id === "catch");
const musicPath = path.join(assetsDir, "music", track.file);
const hasMusic = fs.existsSync(musicPath);
if (!hasMusic) console.warn(`  ⚠ music bed missing: ${musicPath} — proceeding without`);

// Karaoke captions need libass + a font file. The fonts/ directory always
// exists (has a README) so check for any actual .ttf|.otf file instead.
function hasFontFile() {
  const fontsDir = path.join(assetsDir, "fonts");
  if (!fs.existsSync(fontsDir)) return false;
  return fs.readdirSync(fontsDir).some((f) => /\.(ttf|otf)$/i.test(f));
}
const hasKaraoke = fs.existsSync(path.join(tmpDir, "karaoke.ass")) && hasFontFile();
if (!hasKaraoke) console.warn("  ⚠ karaoke captions disabled (no font file in assets/fonts/) — slideshow will run without burned subs");

// ── FFmpeg invocation ───────────────────────────────────────────────────────

const args = [
  "-y",
  // Input 0: slides concat
  "-f", "concat", "-safe", "0", "-i", concatList,
  // Input 1: narration MP3
  "-i", path.join(tmpDir, "narration.mp3"),
];
let nextInputIdx = 2;
const musicIdx = hasMusic ? nextInputIdx++ : -1;
if (hasMusic) args.push("-i", musicPath);
const sfxIndices = [];
for (const cue of sfxCues) {
  sfxIndices.push({ idx: nextInputIdx++, at: cue.at });
  args.push("-i", cue.path);
}

// Video filter: scale + simple ken-burns zoompan. zoompan on a still image
// requires a fixed frame count; we use 30fps × duration per beat.
const videoFilter =
  "[0:v]fps=30,scale=1080:1920:flags=lanczos,setsar=1[v0]";

// Audio mix: a0 (narration) full, a1 (music) -18dB with sidechain duck on
// catch start..end. SFX layered on top.
const filters = [videoFilter];
const audioChunks = [];
audioChunks.push("[1:a]volume=1.0[a_tts]");
if (hasMusic) {
  const duckExpr = catchTiming
    ? `volume=enable='between(t,${catchTiming.start.toFixed(3)},${catchTiming.end.toFixed(3)})':volume=0.25,volume=enable='not(between(t,${catchTiming.start.toFixed(3)},${catchTiming.end.toFixed(3)}))':volume=0.13`
    : "volume=0.13";
  audioChunks.push(`[${musicIdx}:a]aloop=loop=-1:size=2e+09,${duckExpr},atrim=duration=${totalDuration.toFixed(3)}[a_music]`);
}

for (let i = 0; i < sfxIndices.length; i++) {
  const s = sfxIndices[i];
  audioChunks.push(
    `[${s.idx}:a]adelay=${Math.floor(s.at * 1000)}|${Math.floor(s.at * 1000)},volume=0.7[a_sfx${i}]`,
  );
}

const audioLabels = ["[a_tts]"];
if (hasMusic) audioLabels.push("[a_music]");
for (let i = 0; i < sfxIndices.length; i++) audioLabels.push(`[a_sfx${i}]`);
audioChunks.push(
  `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${totalDuration.toFixed(3)}[aout]`,
);
filters.push(audioChunks.join(";"));

let vmap = "[v0]";
if (hasKaraoke) {
  filters.push(
    `[v0]subtitles=${path.join(tmpDir, "karaoke.ass")}:fontsdir=${path.join(assetsDir, "fonts")}[vsub]`,
  );
  vmap = "[vsub]";
}

args.push(
  "-filter_complex", filters.join(";"),
  "-map", vmap,
  "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "23",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "128k",
  "-r", "30",
  "-t", totalDuration.toFixed(3),
  path.join(tmpDir, "video.mp4"),
);

console.log("ffmpeg " + args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));

const res = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
if (res.error) {
  console.error(`ffmpeg spawn error: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`ffmpeg failed with status=${res.status} signal=${res.signal}`);
  process.exit(1);
}

fs.writeFileSync(path.join(tmpDir, "duration.txt"), totalDuration.toFixed(2));
console.log(`\n✓ tmp/video.mp4 assembled, duration ${totalDuration.toFixed(2)}s`);
