// Format B (Walkthrough) video assembly — photo opener + report scroll.
//
// REVISION 2026-06-08 (S49+photos+timing fix):
//
//   • Opens with 1-2 auction photos (HOOK + PROBLEM beats, ~33% of the
//     video). Hard cuts between photos so the viewer sees the actual car
//     before the document scroll starts.
//   • Then animates a 1080×1920 camera scrolling through the full report
//     screenshot for the EVIDENCE + VERDICT + CTA beats. Holds at the
//     bottom for the final 25% so the viewer's eye lands on the closing
//     modules before the brand close.
//   • Total duration tied to narration.mp3 actual length (ffprobed),
//     never just the beat-timestamp sum — the previous flow truncated
//     the audio when TTS padding extended past the last word timestamp.
//   • Fade-out 0.3s at very end.
//
// Inputs:
//   • tmp/row.json
//   • tmp/screens/report-full.png + report-meta.json {width,height,photos[]}
//   • tmp/photos/photo-*.jpg  (0..N — optional, gracefully degrades)
//   • tmp/narration.mp3
//   • tmp/karaoke.ass (optional)
//
// Output: tmp/video.mp4

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const assetsDir = path.join(cwd, "assets");
const screensDir = path.join(tmpDir, "screens");

const row = JSON.parse(fs.readFileSync(path.join(tmpDir, "row.json"), "utf8"));
const wts = JSON.parse(
  fs.readFileSync(path.join(tmpDir, "word-timestamps.json"), "utf8"),
);

// ── Beat timings (used to size the photo segment) ──────────────────────────

const beats = row.script_json?.beats ?? [];
const beatTimings = [];
let prevEnd = 0;
for (let i = 0; i < beats.length; i++) {
  const wtsBeat = wts.per_beat[i];
  const start = prevEnd;
  const end =
    wtsBeat?.end_sec ??
    (wtsBeat?.words?.[wtsBeat.words.length - 1]?.time_sec ?? start) + 0.4;
  beatTimings.push({ id: beats[i].id ?? `beat${i}`, start, end });
  prevEnd = end;
}
const beatTotal = prevEnd;

// ── Narration duration (the AUTHORITATIVE total length) ────────────────────
//
// The prior flow used beatTotal directly + truncated with -t. TTS often
// pads silence past the last word, so the audio extended ~0.5-1.5s past
// the video. ffprobing the actual mp3 fixes the "cuts off at the end"
// complaint.

const narrationPath = path.join(tmpDir, "narration.mp3");
const audioProbe = spawnSync(
  "ffprobe",
  [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    narrationPath,
  ],
  { encoding: "utf8" },
);
const audioDuration = parseFloat((audioProbe.stdout || "0").trim());
const TAIL_PAD_SEC = 0.4; // breathing room after last word + before fade
const totalDuration = Math.max(audioDuration, beatTotal) + TAIL_PAD_SEC;
console.log(
  `Beat-total ${beatTotal.toFixed(2)}s, audio ${audioDuration.toFixed(2)}s → final ${totalDuration.toFixed(2)}s`,
);

// ── Photo + report sizing ──────────────────────────────────────────────────

const meta = JSON.parse(
  fs.readFileSync(path.join(screensDir, "report-meta.json"), "utf8"),
);
const reportW = meta.width ?? 1080;
const reportH = meta.height ?? 1920;
const reportPath = path.join(screensDir, "report-full.png");

// Use only the FIRST 2 photos for the opener — keeps the visual rhythm
// punchy without overwhelming the report demonstration. If only 1 photo
// is available we use that for both halves of the opener with different
// crops (handled in filter graph).
const photoPaths = (meta.photos ?? []).slice(0, 2);
const photoCount = photoPaths.length;

// Photo segment = HOOK + PROBLEM beats (beats[0].end .. beats[1].end).
// If those timings are sparse, fall back to 30% of total. Cap at 12s so
// the report still gets the dominant share.
let photoSegDuration =
  beatTimings.length >= 2 ? beatTimings[1].end : totalDuration * 0.3;
photoSegDuration = Math.min(12, Math.max(4, photoSegDuration));
if (photoCount === 0) photoSegDuration = 0;

const reportSegDuration = totalDuration - photoSegDuration;
const perPhotoDuration = photoCount > 0 ? photoSegDuration / photoCount : 0;

console.log(
  `Segments: photos ${photoCount}×${perPhotoDuration.toFixed(2)}s = ${photoSegDuration.toFixed(2)}s; report scroll ${reportSegDuration.toFixed(2)}s`,
);

// ── Scroll expression (within the report segment) ──────────────────────────
//
// Pan from y=0 to y=(reportH-1920) across the first 75% of the report
// segment, then hold at the bottom for the last 25% so the viewer's eye
// lands on the closing modules before the CTA / fade.

const maxY = Math.max(0, reportH - 1920);
const SCROLL_DUTY = 0.75;
const scrollEnd = Math.max(2.0, reportSegDuration * SCROLL_DUTY);
const scrollExpr =
  maxY === 0
    ? "0"
    : `'min(${maxY}*t/${scrollEnd.toFixed(3)}, ${maxY})'`;

// ── FFmpeg pipeline ────────────────────────────────────────────────────────

const args = ["-y", "-i", narrationPath];

// Photo inputs (each looped + bounded by -t so the filter doesn't have to).
const photoInputIdxStart = 1;
for (let i = 0; i < photoCount; i++) {
  args.push("-loop", "1", "-t", perPhotoDuration.toFixed(3), "-i", photoPaths[i]);
}
// Report input.
const reportInputIdx = photoInputIdxStart + photoCount;
args.push("-loop", "1", "-t", reportSegDuration.toFixed(3), "-i", reportPath);

const filters = [];

// Per-photo: scale-cover to 1080×1920 + fps lock. setsar=1 prevents
// concat-mismatch errors with the report stream.
const photoLabels = [];
for (let i = 0; i < photoCount; i++) {
  const inputIdx = photoInputIdxStart + i;
  const label = `[ph${i}]`;
  filters.push(
    `[${inputIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30${label}`,
  );
  photoLabels.push(label);
}

// Report scroll segment.
filters.push(
  `[${reportInputIdx}:v]fps=30,crop=1080:1920:0:${scrollExpr}:exact=1,setsar=1[rep]`,
);

// Concat photos + report.
const segLabels = [...photoLabels, "[rep]"];
const segCount = segLabels.length;
filters.push(
  `${segLabels.join("")}concat=n=${segCount}:v=1:a=0[vraw]`,
);

let vmap = "[vraw]";

// Optional persona PiP (Phase 1 stub — usually no asset).
const personaPath = path.join(assetsDir, "persona", "persona-front.png");
if (fs.existsSync(personaPath)) {
  args.push("-loop", "1", "-t", totalDuration.toFixed(3), "-i", personaPath);
  const personaIdx = reportInputIdx + 1;
  filters.push(
    `[${personaIdx}:v]scale=378:-1[avatar]`,
    `[vraw][avatar]overlay=W-w-30:H-h-30[vavatar]`,
  );
  vmap = "[vavatar]";
}

// Optional karaoke subs.
const karaokePath = path.join(tmpDir, "karaoke.ass");
const fontsPath = path.join(assetsDir, "fonts");
if (fs.existsSync(karaokePath) && fs.existsSync(fontsPath)) {
  filters.push(
    `${vmap}subtitles=${karaokePath}:fontsdir=${fontsPath}[vsub]`,
  );
  vmap = "[vsub]";
}

// Fade-to-black in the last 0.3s so the close lands smooth.
const fadeStart = Math.max(0, totalDuration - 0.3);
filters.push(`${vmap}fade=t=out:st=${fadeStart.toFixed(3)}:d=0.3[vfade]`);
vmap = "[vfade]";

args.push(
  "-filter_complex", filters.join(";"),
  "-map", vmap,
  "-map", "0:a",
  "-c:v", "libx264", "-preset", "medium", "-crf", "23",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "128k",
  "-r", "30",
  "-t", totalDuration.toFixed(3),
  path.join(tmpDir, "video.mp4"),
);

console.log(
  "\nffmpeg " +
    args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
);
const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (res.status !== 0) {
  console.error(`ffmpeg failed with code ${res.status}`);
  process.exit(1);
}

fs.writeFileSync(
  path.join(tmpDir, "duration.txt"),
  totalDuration.toFixed(2),
);
console.log(`\n✓ tmp/video.mp4 assembled, duration ${totalDuration.toFixed(2)}s`);
