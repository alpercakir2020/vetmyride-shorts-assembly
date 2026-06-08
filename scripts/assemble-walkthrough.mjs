// Format B (Walkthrough) video assembly.
//
// REVISION 2026-06-08 (S49 mid-fix): replaced the per-section slideshow
// with a single full-page report screenshot animated via ffmpeg crop+pan.
// The "camera" scrolls smoothly from top to bottom of the report over the
// video duration, then holds on the verdict at the end. Produces motion +
// product-proof + the document feel the prior 5-still-slideshow lacked.
//
// Inputs:
//   • tmp/row.json
//   • tmp/screens/report-full.png    (full-height crop-detected report)
//   • tmp/screens/report-meta.json   ({width, height} sidecar)
//   • tmp/narration.mp3
//   • tmp/karaoke.ass (optional)
//   • assets/persona/persona-front.png (optional — Phase 2 will swap to
//     Wav2Lip lip-sync)
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

// Beat timings (so the script-gen pacing controls section dwell — see
// scrollExpression below).
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
const totalDuration = prevEnd;

// ── Report-full dimensions ──────────────────────────────────────────────────

const reportPath = path.join(screensDir, "report-full.png");
if (!fs.existsSync(reportPath)) {
  console.error(
    `report-full.png missing — capture-report.mjs must run first`,
  );
  process.exit(1);
}
let reportH = 0;
let reportW = 1080;
const metaPath = path.join(screensDir, "report-meta.json");
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  reportW = meta.width ?? 1080;
  reportH = meta.height ?? 0;
}
if (!reportH) {
  // ffprobe fallback if sidecar missing/stale.
  const probe = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      reportPath,
    ],
    { encoding: "utf8" },
  );
  const [w, h] = (probe.stdout || "").trim().split(",").map((n) => parseInt(n, 10));
  reportW = w || 1080;
  reportH = h || 1920;
}
console.log(`Report image: ${reportW}×${reportH}, total duration ${totalDuration.toFixed(2)}s`);

// ── Scroll expression ──────────────────────────────────────────────────────
//
// Pan a 1080×1920 camera from y=0 to y=(reportH-1920) across the body
// beats. Hold on the verdict (final ~25% of the duration) so the
// viewer's eye lands on the verdict pill + math card before the CTA.
//
// If the report is shorter than 1920px (rare — very thin report), just
// center vertically and skip the pan.
//
// The expression uses ffmpeg's `between()` and clip() to construct a
// piecewise function:
//   t < scrollEnd:  y = (reportH - 1920) * (t / scrollEnd)  (linear pan)
//   t >= scrollEnd: y = (reportH - 1920)                    (hold at bottom)

const maxY = Math.max(0, reportH - 1920);
const HOLD_TAIL_PCT = 0.25; // last 25% of duration holds on verdict
const scrollEnd = Math.max(2.0, totalDuration * (1 - HOLD_TAIL_PCT));
let scrollExpr;
if (maxY === 0) {
  // Report shorter than 1920 — center vertically (negative pan offset puts
  // it mid-frame; if reportH < 1920 then maxY = 0 and crop just shows it).
  scrollExpr = "0";
} else {
  // Linear pan to scrollEnd, then hold. ffmpeg `min()` clamps the upper end.
  scrollExpr = `'min(${maxY}*t/${scrollEnd.toFixed(3)}, ${maxY})'`;
}
console.log(
  `Scroll: maxY=${maxY}, scrollEnd=${scrollEnd.toFixed(2)}s, expr=${scrollExpr}`,
);

// ── Optional persona PiP (Phase 1 = static, Phase 2 = Wav2Lip) ──────────────

function personaPath() {
  const p = path.join(assetsDir, "persona", "persona-front.png");
  return fs.existsSync(p) ? p : null;
}
const persona = personaPath();
const hasKaraoke =
  fs.existsSync(path.join(tmpDir, "karaoke.ass")) &&
  fs.existsSync(path.join(assetsDir, "fonts"));

// ── FFmpeg pipeline ─────────────────────────────────────────────────────────

const args = [
  "-y",
  // Input 0: the full report image, looped to total duration so crop has
  // something to pan over for the entire video.
  "-loop", "1", "-t", totalDuration.toFixed(3), "-i", reportPath,
  // Input 1: narration.
  "-i", path.join(tmpDir, "narration.mp3"),
];
let nextInputIdx = 2;
let personaIdx = -1;
if (persona) {
  personaIdx = nextInputIdx++;
  args.push("-loop", "1", "-i", persona);
}

const filters = [];
// Animate the camera: crop a 1080×1920 sub-rectangle whose y position
// follows scrollExpr. fps=30 produces smooth motion.
filters.push(
  `[0:v]fps=30,crop=1080:1920:0:${scrollExpr}:exact=1,setsar=1[bg]`,
);

let vmap = "[bg]";
if (persona && personaIdx >= 0) {
  filters.push(
    `[${personaIdx}:v]scale=378:-1[avatar]`,
    `[bg][avatar]overlay=W-w-30:H-h-30[vavatar]`,
  );
  vmap = "[vavatar]";
}

if (hasKaraoke) {
  filters.push(
    `${vmap}subtitles=${path.join(tmpDir, "karaoke.ass")}:fontsdir=${path.join(assetsDir, "fonts")}[vsub]`,
  );
  vmap = "[vsub]";
}

// Fade-to-black in the last 0.5s so the close lands smooth.
const fadeStart = Math.max(0, totalDuration - 0.5);
filters.push(`${vmap}fade=t=out:st=${fadeStart.toFixed(3)}:d=0.5[vfade]`);
vmap = "[vfade]";

args.push(
  "-filter_complex", filters.join(";"),
  "-map", vmap,
  "-map", "1:a",
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
console.log(
  `\n✓ tmp/video.mp4 assembled, duration ${totalDuration.toFixed(2)}s`,
);
