// Format A (Roast) — Photo-as-canvas assembly.
//
// The auction photo is the canvas (drift-panned + DP-graded) with transparent
// Satori PNG overlays layered per beat. Multiple photos cut during the CATCH
// beat for visual motion.
//
// v15 STRUCTURAL AUDIO REWRITE — the audio is no longer built inside this
// ffmpeg invocation by guessing where the verdict word lands. synthesize-tts
// emits separate body + verdict clips plus a deterministic manifest
// (tmp/audio-segments.json); buildFinalAudio() concatenates them with EXACT
// measured silences into tmp/audio-final.m4a, then the main pass muxes that
// file directly. The verdict word's position is therefore known to the
// millisecond — killing the "verdict clipped / covered by music / no clear
// ending" bug class that 14 envelope-tweaking versions chased.
//
// Inputs:
//   • tmp/row.json
//   • tmp/overlays/overlay-{1..5}.png  — transparent design layers
//   • tmp/photos/photo-{0..N}.jpg      — auction photo set
//   • tmp/photos/manifest.json         — { photos: [paths], count, fallback }
//   • tmp/audio-segments.json          — deterministic audio-build contract
//   • tmp/tts/beat-{0..2}.mp3, beat-3-math.mp3, verdict.mp3 — voice clips
//   • tmp/word-timestamps.json         — per-beat visual windows (content time)
//   • assets/music/*.mp3               — optional music bed
//
// Per-beat photo strategy:
//   HOOK    → photo 0 (cover) with drift pan
//   SETUP   → continuing, slow pan
//   CATCH   → cut through photos every ~1.4s, accelerating (dopamine beat)
//   VERDICT → report-card mockup, sustained
//   CTA     → report-card mockup, sustained (post-verdict visual hold)
//
// Output: tmp/audio-final.m4a (pre-pass) + tmp/video.mp4 (1080×1920 H.264)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pickTrack } from "./music-cues.mjs";

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
// The deterministic audio-build contract written by synthesize-tts.mjs. Every
// silence, clip path, and the exact verdict-word offset live here — the
// assembler builds audio strictly from this, never by re-deriving timing.
const seg = JSON.parse(
  fs.readFileSync(path.join(tmpDir, "audio-segments.json"), "utf8"),
);
const beats = row.script_json?.beats ?? [];
if (beats.length !== 5) {
  console.error(`expected 5 beats, got ${beats.length}`);
  process.exit(1);
}

// ── Beat timings ────────────────────────────────────────────────────────────

const track = pickTrack(row.id);
// Visual beat windows are taken verbatim from the audio manifest's content
// timeline (synthesize-tts derived both from the SAME ffprobe-measured clip
// durations). No snapToBeat nudging — a ±0.3s shift here would slide the
// verdict report-card overlay off the verdict word, which is the exact desync
// the structural rewrite exists to prevent.
const beatTimings = [];
let prevEnd = 0;
for (let i = 0; i < beats.length; i++) {
  const beat = beats[i];
  const wtsBeat = wts.per_beat[i];
  const start = prevEnd;
  const end = wtsBeat?.end_sec ?? start + (beat.duration_sec ?? 6);
  beatTimings.push({ id: beat.id, start, end, duration: end - start, beat });
  prevEnd = end;
}
// All durations now come from the audio contract, not from local padding math.
//   • PRE_ROLL: clean photo before the first word + overlays slam in.
//   • TAIL: a silent hold on the final FOLLOW frame. The CTA is a SUBSCRIBE
//     ASK now (not a sign-off) — viewers need time to read the card AND tap
//     follow, but the TTS-driven CTA beat is only ~3s. The tail is appended
//     AFTER all spoken content + the verdict word, so it never touches the
//     audio contract (verdict levels / music fade are unchanged). The last
//     canvas segment (line ~210) and the CTA overlay (line ~503) both hold
//     through it; the voice track is padded with silence to match (line ~343).
const PRE_ROLL_SEC = seg.pre_roll_sec ?? 0.5;
const TAIL_SEC = 2.5;
const totalDuration = seg.total_duration_sec + TAIL_SEC;
console.log(
  `Total duration: ${totalDuration.toFixed(2)}s (pre-roll ${PRE_ROLL_SEC}s + content ${prevEnd.toFixed(2)}s) using track ${track.file}`,
);
console.log(
  `Verdict word "${seg.verdict_word}" lands at ${seg.verdict_word_start_sec.toFixed(2)}s — music ends ${(PRE_ROLL_SEC + seg.body_end_content).toFixed(2)}s, clean air around it.`,
);

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

// ── Music detection ─────────────────────────────────────────────────────────

const musicPath = path.join(assetsDir, "music", track.file);
const hasMusic = fs.existsSync(musicPath);
if (!hasMusic)
  console.warn(`  ⚠ music bed missing: ${musicPath} — proceeding without`);

// Karaoke captions disabled in v8 — Studio voices don't expose word-level
// timing and the captions collided with the design overlay text. The TTS
// voice carries narration on its own. (Kept as a flag for the video graph.)
const hasKaraoke = false;

// ── Audio pre-pass: build tmp/audio-final.m4a deterministically ──────────────
//
// The heart of the v15 structural fix. Instead of envelope-guessing where the
// verdict word lands inside one narration file, we CONCATENATE measured clips
// with literal silence so the assembled file IS the timeline:
//
//   [pre-roll] [hook][gap][setup][gap][catch][gap][math]
//     [verdict pre-silence] [VERDICT WORD] [verdict post-silence]
//
// Music plays only under the body and is faded fully out before the verdict
// pre-silence, so the verdict word + sub-bass thump ring in clean air. Every
// offset comes from ffprobe-measured durations (not MP3 byte-size estimates),
// so the word can never drift out of its window. The main video pass then
// muxes this file verbatim — no audio filtergraph, nothing left to guess.
// Measure a clip's true peak (dBFS) so we can lift the one-word verdict clip to
// a fixed target level. Studio-Q emits isolated single words quiet and with a
// steep natural decay; a fixed makeup gain guessed blind either under-shoots
// (verdict buried ~6 dB under the body — the "hard to hear" bug) or clips.
// Measuring the actual clip and computing the exact gain makes the punchline
// land at one predictable level no matter what the TTS engine returns.
function measureClipPeakDb(clipPath) {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "info", "-i", clipPath, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const out = `${r.stderr || ""}${r.stdout || ""}`;
  const m = out.match(/max_volume:\s*(-?[0-9.]+) dB/);
  return m ? parseFloat(m[1]) : null;
}

function buildFinalAudio() {
  const AF = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const bodyClips = seg.body_clips;
  const gaps = seg.body_gap_durs;
  const preRoll = seg.pre_roll_sec;
  const preSil = seg.verdict_pre_silence_sec;
  const postSil = seg.verdict_post_silence_sec;
  const bodyEnd = seg.body_end_content; // content-time end of body voice
  const total = seg.total_duration_sec;
  const musicEnd = preRoll + bodyEnd; // assembled time: music must be gone here

  // Verdict makeup: measure the isolated verdict clip and lift its PEAK to a
  // fixed target so the punchline always sits a touch above the body voice
  // (~-14 dB RMS / ~-4 dB peak), regardless of how quiet Studio-Q renders a
  // one-word clip. Replaces the old fixed +4 dB + compressor, which couldn't
  // engage below its threshold and left the word ~6 dB under the body.
  const VERDICT_TARGET_PEAK_DB = -4;
  const measuredVerdictPeak = measureClipPeakDb(seg.verdict_clip);
  const verdictMakeupDb =
    measuredVerdictPeak == null
      ? 8
      : Math.max(0, Math.min(24, VERDICT_TARGET_PEAK_DB - measuredVerdictPeak));

  const inputs = ["-y"];
  for (const c of bodyClips) inputs.push("-i", c);
  const verdictInIdx = bodyClips.length;
  inputs.push("-i", seg.verdict_clip);
  let musicInIdx = -1;
  if (hasMusic) {
    musicInIdx = bodyClips.length + 1;
    inputs.push("-i", musicPath);
  }

  const f = [];

  // Voice track = lead silence ++ padded body clips ++ pre-silence ++ verdict
  // (+ post-silence), concatenated in play order. Every segment is normalized
  // to the same format + zero-based so the concat filter accepts them.
  f.push(
    `anullsrc=r=48000:cl=stereo,${AF},atrim=duration=${preRoll.toFixed(3)},asetpts=PTS-STARTPTS[lead]`,
  );
  const voiceLabels = ["[lead]"];
  for (let i = 0; i < bodyClips.length; i++) {
    const g = gaps[i] ?? 0;
    const pad = g > 0 ? `,apad=pad_dur=${g.toFixed(3)}` : "";
    f.push(`[${i}:a]${AF}${pad},asetpts=PTS-STARTPTS[b${i}]`);
    voiceLabels.push(`[b${i}]`);
  }
  f.push(
    `anullsrc=r=48000:cl=stereo,${AF},atrim=duration=${preSil.toFixed(3)},asetpts=PTS-STARTPTS[presil]`,
  );
  voiceLabels.push("[presil]");
  // Verdict word: lifted by the measured makeup gain (computed above) so the
  // whole word — vowel and the trailing "k" — lands at one audible level a
  // touch above the body instead of fading out under the listener. No
  // compressor: a downward compressor can't raise a tail that decays below its
  // threshold, and the natural stop-consonant decay reads fine once the word as
  // a whole clears the body voice.
  f.push(
    `[${verdictInIdx}:a]${AF},` +
      `volume=${verdictMakeupDb.toFixed(2)}dB,` +
      `apad=pad_dur=${postSil.toFixed(3)},asetpts=PTS-STARTPTS[verd]`,
  );
  voiceLabels.push("[verd]");
  f.push(
    `${voiceLabels.join("")}concat=n=${voiceLabels.length}:v=0:a=1[voiceraw]`,
  );
  // Lock the voice track to the contract length + the silent CTA hold tail.
  // The pad is pure silence appended AFTER the verdict + post-silence, so the
  // verdict word's baked-in level/position is untouched — it just keeps the
  // muxed audio as long as the held video (FOLLOW frame) so ffmpeg's -t
  // doesn't cut to a shorter audio stream.
  const finalLen = total + TAIL_SEC;
  f.push(`[voiceraw]apad=pad_dur=${(0.5 + TAIL_SEC).toFixed(3)},atrim=duration=${finalLen.toFixed(3)}[voice]`);

  const mixLabels = ["[voice]"];

  // Music: gentle bed under the body, ducked harder through CATCH, then faded
  // fully out by musicEnd and hard-trimmed so NOTHING plays over the verdict.
  if (hasMusic) {
    const [cs, ce] = seg.catch_window_content;
    const catchStart = (cs + preRoll).toFixed(3);
    const catchEnd = (ce + preRoll).toFixed(3);
    const fadeStart = Math.max(0, musicEnd - 0.5).toFixed(3);
    f.push(
      `[${musicInIdx}:a]aloop=loop=-1:size=2e+09,${AF},` +
        `volume=enable='not(between(t,${catchStart},${catchEnd}))':volume=0.12,` +
        `volume=enable='between(t,${catchStart},${catchEnd})':volume=0.07,` +
        `afade=out:st=${fadeStart}:d=0.5,atrim=duration=${musicEnd.toFixed(3)}[music]`,
    );
    mixLabels.push("[music]");
  }

  // Sub-bass thump fired as a tight PRE-HIT, 180ms before the verdict word and
  // fully decayed (~word+0.04) before the vowel is intelligible — so it
  // punctuates the silence like a drum downbeat instead of masking the word's
  // low formants (the old 0.45s/-50ms thump rang straight through "Walk.").
  // 90Hz fundamental + 180Hz overtone so phone speakers (which can't reproduce
  // <150Hz) still feel the impact. Kept low (~-15 dB, ≈ body level) so it never
  // becomes the loudest thing in the verdict window: a hot thump dominated
  // dynaudnorm's gain and dragged the word back down ~12 dB under it.
  const thumpStart = Math.max(0, seg.verdict_word_start_sec - 0.18);
  const thumpMs = Math.floor(thumpStart * 1000);
  const tone = "0.7*sin(2*PI*90*t)+0.4*sin(2*PI*180*t)";
  f.push(
    `aevalsrc='${tone}|${tone}':channel_layout=stereo:sample_rate=48000:duration=0.24,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `afade=in:st=0:d=0.02,afade=out:st=0.12:d=0.10,lowpass=f=300,` +
      `adelay=${thumpMs}|${thumpMs},volume=0.4[thump]`,
  );
  mixLabels.push("[thump]");

  // normalize=0 → pure sum (no per-input attenuation when music ends early),
  // then dynaudnorm to lift level while preserving the designed silences/boosts.
  f.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0,` +
      `dynaudnorm=f=300:g=11[aout]`,
  );

  const args = [
    ...inputs,
    "-filter_complex",
    f.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    path.join(tmpDir, "audio-final.m4a"),
  ];
  console.log(
    "\n[audio pre-pass] ffmpeg " +
      args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
  );
  const r = spawnSync("ffmpeg", args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.error) {
    console.error(`audio pre-pass spawn error: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(
      `audio pre-pass failed status=${r.status} signal=${r.signal}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ tmp/audio-final.m4a built — ${total.toFixed(2)}s, verdict "${seg.verdict_word}" @ ${seg.verdict_word_start_sec.toFixed(2)}s ` +
      `(measured peak ${measuredVerdictPeak == null ? "n/a" : `${measuredVerdictPeak.toFixed(1)}dB`} → makeup +${verdictMakeupDb.toFixed(1)}dB)`,
  );
}

buildFinalAudio();

// ── FFmpeg invocation (video pass) ──────────────────────────────────────────
//
// Audio is already fully built (tmp/audio-final.m4a). This pass renders the
// video filtergraph and muxes that audio file in verbatim — there is no audio
// filtergraph here at all, so nothing about the verdict timing can change.

const args = [
  "-y",
  // Input 0: photo concat → canvas video stream
  "-f", "concat", "-safe", "0", "-i", concatList,
];

let nextInputIdx = 1;
const overlayInputIndices = [];
for (const p of overlayPaths) {
  overlayInputIndices.push(nextInputIdx++);
  // `-t` bounds the looped still so the fade filter can compute alpha
  // durations correctly (ffmpeg 6.x throws "Error reinitializing filters"
  // on infinite-duration inputs otherwise).
  args.push("-loop", "1", "-t", totalDuration.toFixed(3), "-i", p);
}

// Final input: the deterministic pre-built audio. Muxed with -c:a copy.
const audioFinalIdx = nextInputIdx++;
args.push("-i", path.join(tmpDir, "audio-final.m4a"));

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
  // photo-only window. The LAST overlay (CTA / FOLLOW card) holds through the
  // silent TAIL so the subscribe ask stays readable + tappable; every other
  // overlay ends at its beat boundary.
  const isLastBeat = i === overlayPaths.length - 1;
  const ovStart = t.start + PRE_ROLL_SEC;
  const ovEnd = t.end + PRE_ROLL_SEC + (isLastBeat ? TAIL_SEC : 0);
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

// Audio is already finalized in tmp/audio-final.m4a (the deterministic
// pre-pass above). Mux it in with -c:a copy — no audio filtergraph here, so
// the verdict word's baked-in position is final and unguessable. filters
// holds ONLY the video graph at this point.
args.push(
  "-filter_complex", filters.join(";"),
  "-map", vmap,
  "-map", `${audioFinalIdx}:a`,
  "-c:v", "libx264", "-preset", "medium", "-crf", "23",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-c:a", "copy",
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
