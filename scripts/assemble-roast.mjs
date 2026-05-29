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
// Pad both ends so the video doesn't clip in/out mid-frame:
//   • PRE_ROLL: photo shows clean for the first 0.5s before overlays slam in.
//     Matches algo-specialist's "first 0.5s = single shocking visual, no chrome"
//     guidance.
//   • TAIL: hold last frame 1s past TTS end so the close lands smooth.
const PRE_ROLL_SEC = 0.5;
const TAIL_SEC = 1.0;
const totalDuration = PRE_ROLL_SEC + prevEnd + TAIL_SEC;
console.log(`Total duration: ${totalDuration.toFixed(2)}s (pre-roll ${PRE_ROLL_SEC}s + content ${prevEnd.toFixed(2)}s + tail ${TAIL_SEC}s) using track ${track.file}`);

// ── Per-beat photo assignment ───────────────────────────────────────────────

const photoPaths = photoManifest.photos;
const reportCardPath = photoManifest.report_card;
const coverPhoto = photoPaths[0];

// CATCH cycle: spread remaining photos across the catch duration.
// If we only have 1 photo (fallback), CATCH stays on cover.
const catchTiming = beatTimings.find((t) => t.id === "catch");
const catchPhotos = photoPaths.length > 1 ? photoPaths.slice(1) : [coverPhoto];

/**
 * Build the photo timeline — segments of (photo, start, end, beatId).
 *
 * v10: hard cuts between varied photo crops driven by the script.
 * v12: energy curve via shot-duration acceleration. Mobile Shorts editor:
 * "shot duration getting shorter into the verdict, then longer for the
 * hold." Slap → tease → escalate → BANG → exhale.
 *
 *   HOOK    (4s)  — 2 cuts at 2.0s (let viewer ingest the opening)
 *   SETUP   (4s)  — 2 cuts at 2.0s (medium pace, sets up)
 *   CATCH   (11s) — 7 cuts ACCELERATING: 2.0s → 1.5s → 1.0s (tension builds)
 *   VERDICT (4s)  — report card, sustained (no cuts — landing requires hold)
 *   CTA     (3s)  — report card sustained
 */
function buildPhotoSegments() {
  const segs = [];
  for (const t of beatTimings) {
    // Verdict + CTA → product mockup canvas, sustained (motion docs editor:
    // "hold the verdict frame 1.5s — the only sustained shot in the video").
    if ((t.id === "verdict" || t.id === "cta") && reportCardPath) {
      segs.push({ photo: reportCardPath, start: t.start, end: t.end, beatId: t.id, dur: t.duration });
      continue;
    }

    // Compute number of sub-cuts based on beat — biased toward more cuts
    // on CATCH for the dopamine beat.
    let nCuts;
    if (t.id === "catch") {
      nCuts = Math.max(3, Math.min(8, Math.round(t.duration / 1.4)));
    } else {
      nCuts = Math.max(1, Math.min(3, Math.round(t.duration / 1.8)));
    }

    // Build sub-cut durations. For CATCH, accelerate (earlier cuts longer,
    // later cuts shorter) so tension builds into the verdict reveal.
    const subDurs = [];
    if (t.id === "catch" && nCuts >= 3) {
      // Geometric acceleration: each cut ~13% shorter than the previous.
      // Normalize so the total still equals t.duration.
      const ratio = 0.87;
      let acc = 0;
      const weights = [];
      for (let i = 0; i < nCuts; i++) {
        const w = Math.pow(ratio, i);
        weights.push(w);
        acc += w;
      }
      for (const w of weights) subDurs.push((w / acc) * t.duration);
    } else {
      for (let i = 0; i < nCuts; i++) subDurs.push(t.duration / nCuts);
    }

    let s = t.start;
    for (let i = 0; i < nCuts; i++) {
      const subDur = subDurs[i];
      let pickIdx;
      switch (t.id) {
        case "hook":   pickIdx = i; break;
        case "setup":  pickIdx = (photoPaths.length > 2 ? 2 : 0) + i; break;
        case "catch":  pickIdx = (photoPaths.length > 4 ? 4 : 0) + i; break;
        default:       pickIdx = i;
      }
      const photo = photoPaths[pickIdx % photoPaths.length] ?? coverPhoto;
      segs.push({
        photo,
        start: s,
        end: s + subDur,
        beatId: t.id,
        dur: subDur,
        subIndex: i,
        totalSubs: nCuts,
      });
      s += subDur;
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
const lines = photoSegments.map((s, i) => {
  let dur = s.dur;
  if (i === 0) dur += PRE_ROLL_SEC; // extend first segment for pre-roll
  if (i === photoSegments.length - 1) dur += TAIL_SEC; // extend last for tail hold
  return `file '${s.photo}'\nduration ${dur.toFixed(3)}`;
});
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

// Script-driven SFX disabled in v13. Per sound designer + user feedback:
// random whooshes/buzzers/alarms at beat boundaries felt disconnected
// from the visuals (no audio-visual punctuation). The sub-bass thump on
// the verdict word is the only sonic accent we keep — it has a clear
// visual partner (the PASS pill).
const sfxCues = [];

// ── Music + karaoke detection ───────────────────────────────────────────────

const musicPath = path.join(assetsDir, "music", track.file);
const hasMusic = fs.existsSync(musicPath);
if (!hasMusic) console.warn(`  ⚠ music bed missing: ${musicPath} — proceeding without`);

// Karaoke captions disabled in v8 — Studio voices don't expose word-level
// timing (we'd have to estimate), and the captions kept colliding with the
// design overlay text regardless of MarginV. The TTS voice carries the
// narration on its own. Re-enable when we either:
//   • Switch to a Wavenet/Neural2 voice (supports SSML marks for exact timing)
//   • Upgrade to ElevenLabs (has word-level timing in their API)
const hasKaraoke = false;

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
  // `-t` bounds the looped still so the fade filter can compute
  // alpha durations correctly (otherwise ffmpeg 6.x throws
  // "Error reinitializing filters" on infinite-duration inputs).
  args.push("-loop", "1", "-t", totalDuration.toFixed(3), "-i", p);
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

// Canvas with gentle drift motion. Scale source to a slightly oversized
// canvas (1188×2112 = 110%) then crop a moving 1080×1920 window across
// the duration. zoompan crashes with concat-of-image-stills inputs, but
// scale+crop with time-keyed expressions works reliably.
//
// Pan diagonally — x drifts left-to-right, y drifts top-to-bottom — over
// the full duration. Total visual drift ~108px over 33s = barely
// perceptible per-frame but kills the "static slideshow" signal.
const PAN_X_RANGE = 108; // (1188-1080)
const PAN_Y_RANGE = 192; // (2112-1920)
// DP-grade chain applied AFTER the time-keyed crop pan and BEFORE Satori
// overlays composite. Per the cinematographer expert review: this single
// chain transforms the flat-lit Copart stock photo into something that
// reads "shot with intent" — crushed blacks, lifted contrast, slight
// vignette gravity, 35mm-style grain. ~25ms/frame extra render.
const PHOTO_GRADE =
  "curves=preset=increase_contrast," +
  "eq=saturation=1.15:contrast=1.10:gamma=0.95," +
  "vignette=PI/4.5," +
  "noise=alls=7:allf=t+u";
filters.push(
  `[0:v]fps=30,scale=1188:2112:force_original_aspect_ratio=increase,crop=1188:2112,setsar=1,crop=1080:1920:x='${PAN_X_RANGE}*t/${totalDuration.toFixed(3)}':y='${PAN_Y_RANGE}*t/${(totalDuration * 2).toFixed(3)} + ${PAN_Y_RANGE / 4}',${PHOTO_GRADE}[bg]`,
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
  // Shift overlay times by PRE_ROLL_SEC since the canvas now has a leading
  // photo-only window.
  const ovStart = t.start + PRE_ROLL_SEC;
  const ovEnd = t.end + PRE_ROLL_SEC;
  const inputIdx = overlayInputIndices[i];
  const overlayInTag = `[ov${i}_fx]`;
  filters.push(
    `[${inputIdx}:v]scale=1080:1920,setsar=1,format=rgba,` +
    `fade=in:st=${ovStart.toFixed(3)}:d=${FADE_IN}:alpha=1,` +
    `fade=out:st=${(ovEnd - FADE_OUT).toFixed(3)}:d=${FADE_OUT}:alpha=1` +
    overlayInTag,
  );
  const outTag = i === overlayPaths.length - 1 ? "[vmix]" : `[v${i}]`;
  filters.push(
    `${prev}${overlayInTag}overlay=0:0:enable='between(t,${ovStart.toFixed(3)},${ovEnd.toFixed(3)})'${outTag}`,
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
// Fade-to-black in the last 0.5s so the close lands smooth instead of cutting.
const fadeStart = Math.max(0, totalDuration - 0.5);
filters.push(`${vmap}fade=t=out:st=${fadeStart.toFixed(3)}:d=0.5[vfade]`);
vmap = "[vfade]";

// Audio mix:
//   • Pad TTS with PRE_ROLL_SEC of leading silence so the narration doesn't
//     start mid-word.
//   • Fade out the music in the last ~0.6s of the tail.
//   • Boost TTS volume during the verdict silence window so the verdict
//     word LANDS instead of disappearing into the dropped music.
const audioFadeStart = Math.max(0, totalDuration - 0.6);
const audioChunks = [
  `[1:a]adelay=${Math.floor(PRE_ROLL_SEC * 1000)}|${Math.floor(PRE_ROLL_SEC * 1000)},` +
  `volume=enable='between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)})':volume=2.0,` +
  `volume=enable='not(between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)}))':volume=1.0[a_tts]`,
];
// Verdict-moment timing (v11): all 4 video-craft experts independently
// converged on the same single moment — the verdict word needs SILENCE
// around it + a sub-bass thump under it.
//
// Assumption: TTS verdict word ("Walk." "Pass.") lands in the final
// ~0.45s of beat 4. We define a silence window from -0.30s before to
// +0.20s after the verdict word, and trigger a 0.45s sub-bass tone
// under the word itself.
const verdictBeat = beatTimings[3]; // VERDICT is the 4th beat (index 3)
const verdictWordStart = verdictBeat.end - 0.45 + PRE_ROLL_SEC;
const verdictWordEnd = verdictBeat.end + PRE_ROLL_SEC;
const silenceStart = verdictWordStart - 0.30;
const silenceEnd = verdictWordEnd + 0.20;

if (hasMusic) {
  // Shift CATCH duck window by PRE_ROLL_SEC since the timeline shifted.
  const catchStart = catchTiming ? catchTiming.start + PRE_ROLL_SEC : 0;
  const catchEnd = catchTiming ? catchTiming.end + PRE_ROLL_SEC : 0;
  // Music volume:
  //   • During CATCH: duck to 25% (TTS rides above)
  //   • During verdict silence window: -inf (let the word breathe)
  //   • Otherwise: 13% baseline bed
  // Compose music volume expression as a SINGLE quoted enable per volume
  // filter. ffmpeg evaluates `enable` as a numeric expression where 0=off,
  // nonzero=on. Multiple conditions combine via multiplication (*).
  // Order matters: later volume= entries override earlier ones for the
  // overlapping windows. Apply silence LAST so it wins on the verdict.
  const baseline = catchTiming
    ? `volume=enable='not(between(t,${catchStart.toFixed(3)},${catchEnd.toFixed(3)}))*not(between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)}))':volume=0.13,` +
      `volume=enable='between(t,${catchStart.toFixed(3)},${catchEnd.toFixed(3)})*not(between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)}))':volume=0.25`
    : `volume=enable='not(between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)}))':volume=0.13`;
  const duckExpr =
    `${baseline},` +
    `volume=enable='between(t,${silenceStart.toFixed(3)},${silenceEnd.toFixed(3)})':volume=0.0`;
  audioChunks.push(`[${musicIdx}:a]aloop=loop=-1:size=2e+09,${duckExpr},afade=out:st=${audioFadeStart.toFixed(3)}:d=0.6,atrim=duration=${totalDuration.toFixed(3)}[a_music]`);
}

// Sub-bass thump under the verdict word. Generated via ffmpeg's aevalsrc
// (no SFX file needed) — a low-pass'd sine burst at 55Hz, 0.45s, with a
// fast attack and slow decay envelope. Triggers 50ms before verdict word
// so the impact lands ON the word.
const thumpStart = Math.max(0, verdictWordStart - 0.05);
const thumpInputIdx = nextInputIdx++;
args.push(
  "-f", "lavfi",
  "-t", "0.45",
  "-i", "aevalsrc='0.55*sin(2*PI*55*t)':sample_rate=48000:duration=0.45",
);
// Envelope via afade: 50ms attack + 50ms release on a 0.45s tone.
// Simpler + more reliable than expression-based volume (which was
// throwing NaN on filter init).
audioChunks.push(
  `[${thumpInputIdx}:a]afade=in:st=0:d=0.05,afade=out:st=0.4:d=0.05,lowpass=f=180,adelay=${Math.floor(thumpStart * 1000)}|${Math.floor(thumpStart * 1000)},volume=0.7[a_thump]`,
);
for (let i = 0; i < sfxIndices.length; i++) {
  const s = sfxIndices[i];
  // Shift SFX cues by PRE_ROLL_SEC so they land at the right beat moment.
  const at = s.at + PRE_ROLL_SEC;
  audioChunks.push(
    `[${s.idx}:a]adelay=${Math.floor(at * 1000)}|${Math.floor(at * 1000)},volume=0.7[a_sfx${i}]`,
  );
}
const audioLabels = ["[a_tts]"];
if (hasMusic) audioLabels.push("[a_music]");
audioLabels.push("[a_thump]"); // v11: sub-bass thump under verdict word
for (let i = 0; i < sfxIndices.length; i++) audioLabels.push(`[a_sfx${i}]`);
// Loudnorm to -14 LUFS (Shorts shelf broadcast target). Without this the
// video sounds thin sandwiched between TikTok-imports averaging -8 LUFS.
// Use dynaudnorm instead of loudnorm — dynaudnorm respects intentional
// volume design (silences stay silent, boosts stay boosted) whereas
// loudnorm's dynamic mode was equalizing the verdict-moment polish away.
audioChunks.push(
  `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,dynaudnorm=f=300:g=11,atrim=duration=${totalDuration.toFixed(3)}[aout]`,
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
