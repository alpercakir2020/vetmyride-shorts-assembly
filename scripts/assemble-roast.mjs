// Format A (Roast) — Photo-as-canvas v2 assembly.
//
// v1 used Satori slides AS the canvas. v2 puts the auction photo as the
// canvas (Ken-Burns animated) and layers transparent Satori PNG overlays
// on top per beat. Multiple photos cycle during the CATCH beat for visual
// motion.
//
// Inputs:
//   • tmp/row.json
//   • tmp/overlays/overlay-{1..5}.png  — transparent design layers
//   • tmp/photos/photo-{0..N}.jpg      — auction photo set
//   • tmp/photos/manifest.json         — { photos: [paths], count, fallback }
//   • tmp/narration.mp3                — TTS narration
//   • tmp/word-timestamps.json         — per-beat timing
//   • tmp/karaoke.ass                  — burned karaoke captions (optional)
//   • assets/sfx/*.wav, assets/music/*, assets/fonts/*.ttf — optional
//
// Per-beat photo strategy:
//   HOOK    → photo 0 (cover) with Ken-Burns zoom-in
//   SETUP   → photo 0 continuing, slow pan
//   CATCH   → cycle through photos 1..N every 1.5s (dopamine beat)
//   VERDICT → photo 0 returns, dimmed
//   CTA     → photo 0 with full overlay
//
// Output: tmp/video.mp4 (1080×1920 H.264, ~32s)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pickTrack, snapToBeat } from "./music-cues.mjs";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const assetsDir = path.join(cwd, "assets");
const overlaysDir = path.join(tmpDir, "overlays");
const photosDir = path.join(tmpDir, "photos");

const row = JSON.parse(fs.readFileSync(path.join(tmpDir, "row.json"), "utf8"));
const wts = JSON.parse(
  fs.readFileSync(path.join(tmpDir, "word-timestamps.json"), "utf8"),
);
const photoManifest = JSON.parse(
  fs.readFileSync(path.join(photosDir, "manifest.json"), "utf8"),
);
const beats = row.script_json?.beats ?? [];
if (beats.length !== 5) {
  console.error(`expected 5 beats, got ${beats.length}`);
  process.exit(1);
}

// ── Beat timings ────────────────────────────────────────────────────────────

const track = pickTrack(row.id);
const beatTimings = [];
let prevEnd = 0;
for (let i = 0; i < beats.length; i++) {
  const beat = beats[i];
  const wtsBeat = wts.per_beat[i];
  const start = prevEnd;
  const nominalEnd =
    wtsBeat?.end_sec ??
    (wtsBeat?.words?.[wtsBeat.words.length - 1]?.time_sec ?? start) + 0.4 ??
    start + (beat.duration_sec ?? 6);
  const snapped = snapToBeat(track, nominalEnd);
  const end = Math.abs(snapped - nominalEnd) < 0.3 ? snapped : nominalEnd;
  beatTimings.push({ id: beat.id, start, end, duration: end - start, beat });
  prevEnd = end;
}
const totalDuration = prevEnd;
console.log(`Total duration: ${totalDuration.toFixed(2)}s using track ${track.file}`);

// ── Per-beat photo assignment ───────────────────────────────────────────────

const photoPaths = photoManifest.photos;
const coverPhoto = photoPaths[0];

// CATCH cycle: spread remaining photos across the catch duration.
// If we only have 1 photo (fallback), CATCH stays on cover.
const catchTiming = beatTimings.find((t) => t.id === "catch");
const catchPhotos = photoPaths.length > 1 ? photoPaths.slice(1) : [coverPhoto];

/** Build the photo timeline — segments of (photo, start, end, beatId). */
function buildPhotoSegments() {
  const segs = [];
  for (const t of beatTimings) {
    if (t.id === "catch" && catchPhotos.length > 1) {
      // Cycle through catchPhotos every ~1.5s
      const perPhotoDur = t.duration / catchPhotos.length;
      let s = t.start;
      for (let i = 0; i < catchPhotos.length; i++) {
        const e = i === catchPhotos.length - 1 ? t.end : s + perPhotoDur;
        segs.push({ photo: catchPhotos[i], start: s, end: e, beatId: t.id, dur: e - s });
        s = e;
      }
    } else {
      segs.push({ photo: coverPhoto, start: t.start, end: t.end, beatId: t.id, dur: t.duration });
    }
  }
  return segs;
}

const photoSegments = buildPhotoSegments();
console.log(`Photo timeline: ${photoSegments.length} segments`);
for (const s of photoSegments) {
  console.log(`  ${s.beatId.padEnd(7)} ${s.start.toFixed(2)}-${s.end.toFixed(2)}s  ${path.basename(s.photo)}`);
}

// ── Build photo concat list with Ken Burns ──────────────────────────────────
//
// Strategy: ffmpeg concat demuxer with `duration` for each photo gives us
// the timeline. Ken-Burns zoompan is applied as a filter on the concatenated
// stream — but zoompan with concat is tricky. Cleaner approach: pre-process
// each photo into a fixed-duration video clip with zoompan, then concat
// those clips. Slower but produces clean motion.
//
// For simplicity in v2.0, use the concat demuxer with image stills (each
// photo held for its segment duration) PLUS a global zoompan over the whole
// concatenated stream. This gives a continuous zoom that resets at each
// photo change. Good enough as the first motion pass.

const concatList = path.join(tmpDir, "concat.txt");
const lines = photoSegments.map(
  (s) => `file '${s.photo}'\nduration ${s.dur.toFixed(3)}`,
);
// Last entry repeated without duration anchors the end (ffmpeg concat quirk)
lines.push(`file '${photoSegments[photoSegments.length - 1].photo}'`);
fs.writeFileSync(concatList, lines.join("\n"));

// ── Overlay timing list ─────────────────────────────────────────────────────
//
// Each beat's overlay is enabled during that beat's timestamp range. ffmpeg
// `overlay` filter with `enable` expression switches overlays in/out.

const overlayPaths = [];
for (let i = 1; i <= 5; i++) {
  const p = path.join(overlaysDir, `overlay-${i}.png`);
  if (!fs.existsSync(p)) {
    console.error(`overlay ${i} missing: ${p}`);
    process.exit(1);
  }
  overlayPaths.push(p);
}

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

// ── Music + karaoke detection ───────────────────────────────────────────────

const musicPath = path.join(assetsDir, "music", track.file);
const hasMusic = fs.existsSync(musicPath);
if (!hasMusic) console.warn(`  ⚠ music bed missing: ${musicPath} — proceeding without`);

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
  // Input 0: photo concat → canvas video stream
  "-f", "concat", "-safe", "0", "-i", concatList,
  // Input 1: narration MP3
  "-i", path.join(tmpDir, "narration.mp3"),
];

let nextInputIdx = 2;
const overlayInputIndices = [];
for (const p of overlayPaths) {
  overlayInputIndices.push(nextInputIdx++);
  args.push("-loop", "1", "-i", p);
}

const musicIdx = hasMusic ? nextInputIdx++ : -1;
if (hasMusic) args.push("-i", musicPath);

const sfxIndices = [];
for (const cue of sfxCues) {
  sfxIndices.push({ idx: nextInputIdx++, at: cue.at });
  args.push("-i", cue.path);
}

// Video filter graph:
//   1. Scale photo stream to 1080×1920 (cover), apply Ken Burns zoom
//   2. Chain 5 overlay filters, each enabled during its beat range
//   3. Optionally burn karaoke subs

const filters = [];

// Canvas: scale + zoompan Ken Burns (slow zoom-in 1.0→1.08 over the video)
filters.push(
  "[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,zoompan=z='min(1+0.0006*on,1.08)':d=1:s=1080x1920:fps=30[bg]",
);

// Build chained overlay filters
let prev = "[bg]";
for (let i = 0; i < overlayPaths.length; i++) {
  const t = beatTimings[i];
  const inputIdx = overlayInputIndices[i];
  // Scale overlay to exact frame size, set proper sar, then composite with timing gate
  const overlayInTag = `[ov${i}_scaled]`;
  filters.push(`[${inputIdx}:v]scale=1080:1920,setsar=1${overlayInTag}`);
  const outTag = i === overlayPaths.length - 1 ? "[vmix]" : `[v${i}]`;
  filters.push(
    `${prev}${overlayInTag}overlay=0:0:enable='between(t,${t.start.toFixed(3)},${t.end.toFixed(3)})'${outTag}`,
  );
  prev = outTag;
}

let vmap = "[vmix]";
if (hasKaraoke) {
  filters.push(
    `[vmix]subtitles=${path.join(tmpDir, "karaoke.ass")}:fontsdir=${path.join(assetsDir, "fonts")}[vsub]`,
  );
  vmap = "[vsub]";
}

// Audio mix
const audioChunks = ["[1:a]volume=1.0[a_tts]"];
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

console.log("\nffmpeg " + args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));

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
