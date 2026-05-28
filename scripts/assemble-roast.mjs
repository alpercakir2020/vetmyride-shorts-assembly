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

// DejaVu Sans is pre-installed on Ubuntu GHA runners — no font file needed.
// On macOS dev, fall back to the system fonts.
const hasKaraoke = fs.existsSync(path.join(tmpDir, "karaoke.ass"));
if (!hasKaraoke) console.warn("  ⚠ karaoke.ass not found — slideshow will run without burned subs");

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

// ── Canvas with per-beat Ken Burns motion ─────────────────────────────────
//
// Different framing per beat gives visual variety from a single photo:
//   HOOK    — slow zoom-in (1.0 → 1.06)
//   SETUP   — slight pan-right (1.05, x shift)
//   CATCH   — dramatic zoom-in to bottom (1.0 → 1.20) — the dopamine beat
//   VERDICT — pull back from CATCH (1.20 → 1.00) for the reveal
//   CTA     — subtle drift (1.0 → 1.04)
//
// Expressed as piecewise time-keyed zoom on a single zoompan filter.

const tHook = beatTimings[0].end;
const tSetup = beatTimings[1].end;
const tCatch = beatTimings[2].end;
const tVerdict = beatTimings[3].end;

// Piecewise zoom expression: lerp between fixed zoom points at beat boundaries
function zoomExpr() {
  // Each segment: if t in [a,b], z = za + (zb-za)*(t-a)/(b-a)
  return (
    `if(lt(t,${tHook.toFixed(3)}),` +
    `1.0+0.06*(t/${tHook.toFixed(3)}),` +
    `if(lt(t,${tSetup.toFixed(3)}),` +
    `1.06-0.02*((t-${tHook.toFixed(3)})/${(tSetup - tHook).toFixed(3)}),` +
    `if(lt(t,${tCatch.toFixed(3)}),` +
    `1.04+0.16*((t-${tSetup.toFixed(3)})/${(tCatch - tSetup).toFixed(3)}),` +
    `if(lt(t,${tVerdict.toFixed(3)}),` +
    `1.20-0.20*((t-${tCatch.toFixed(3)})/${(tVerdict - tCatch).toFixed(3)}),` +
    `1.0+0.04*((t-${tVerdict.toFixed(3)})/${(totalDuration - tVerdict).toFixed(3)})` +
    `))))`
  );
}

filters.push(
  `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,zoompan=z='${zoomExpr()}':d=1:s=1080x1920:fps=30[bg]`,
);

// ── Overlay layers with fade-in / fade-out animation ──────────────────────
//
// Each overlay gets:
//   • fade=in over 0.30s starting at its beat begin
//   • fade=out over 0.20s ending at its beat end
//   • enable gate so it's only mixed during the beat window
//
// Result: overlays SLAM in (fade-in feels like a slam at 30fps) instead
// of hard-cutting visibility.

const FADE_IN = 0.30;
const FADE_OUT = 0.20;
let prev = "[bg]";
for (let i = 0; i < overlayPaths.length; i++) {
  const t = beatTimings[i];
  const inputIdx = overlayInputIndices[i];
  const overlayInTag = `[ov${i}_fx]`;
  // Pre-process: scale to frame, then fade in/out timed to the beat
  filters.push(
    `[${inputIdx}:v]scale=1080:1920,setsar=1,format=rgba,` +
    `fade=in:st=${t.start.toFixed(3)}:d=${FADE_IN}:alpha=1,` +
    `fade=out:st=${(t.end - FADE_OUT).toFixed(3)}:d=${FADE_OUT}:alpha=1` +
    overlayInTag,
  );
  const outTag = i === overlayPaths.length - 1 ? "[vmix]" : `[v${i}]`;
  filters.push(
    `${prev}${overlayInTag}overlay=0:0:enable='between(t,${t.start.toFixed(3)},${t.end.toFixed(3)})'${outTag}`,
  );
  prev = outTag;
}

let vmap = "[vmix]";
if (hasKaraoke) {
  // No fontsdir — libass uses system fonts. DejaVu Sans is on Ubuntu by default.
  filters.push(
    `[vmix]subtitles=${path.join(tmpDir, "karaoke.ass")}[vsub]`,
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
