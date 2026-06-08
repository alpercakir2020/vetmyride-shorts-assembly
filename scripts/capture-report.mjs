// Format B (Walkthrough) capture: take a SINGLE full-page screenshot of
// the report at 1080 width and 8000 height (Chrome viewport equals
// window-size, so the entire page renders in one shot). The assembler
// uses ffmpeg cropdetect to trim trailing whitespace and then animates
// a 1080×1920 camera scrolling through the tall image — making the
// "Walkthrough" format actually look like a walkthrough instead of
// 5 isolated module screenshots.
//
// REVISION 2026-06-08 (S49 mid-fix): the previous flow captured 5
// separate /m/[id]?capture=1&section=X screenshots and stitched them
// into a slideshow. Result was visually dull / empty — each beat was a
// single ReportView module on white background, no movement. The new
// flow shows the whole report top-to-bottom in motion.
//
// Output: tmp/screens/report-full.png

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SITE_URL = process.env.SITE_URL ?? "https://vetmyride.com";
const row = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);
if (row.format !== "walkthrough") {
  console.error("not a walkthrough row");
  process.exit(1);
}
const reportId = row.source_slug;

const screensDir = path.join(process.cwd(), "tmp", "screens");
fs.mkdirSync(screensDir, { recursive: true });

const chromium = process.env.CHROMIUM_PATH ?? "chromium";
const url = `${SITE_URL}/m/${reportId}?capture=1`;
const outPath = path.join(screensDir, "report-full.png");

console.log(`Capturing full report → ${outPath}`);
console.log(`  URL: ${url}`);

// Chrome captures whatever fits in the viewport. Set viewport very tall
// (1080×8000) so the entire report renders in one frame. Reports tend to
// run 4000-6500px tall depending on lot data; 8000 is generous. Trailing
// whitespace is trimmed below by ffmpeg cropdetect.
const res = spawnSync(
  chromium,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1080,8000",
    `--screenshot=${outPath}`,
    // Long virtual-time-budget: the report fetches data client-side from
    // Supabase and renders many modules. 12s is enough for cold-start
    // hydration on a fresh deploy + image lazy-loading to settle.
    "--virtual-time-budget=12000",
    url,
  ],
  { stdio: "inherit" },
);

if (res.status !== 0) {
  console.error(`  ✗ chromium failed (code ${res.status})`);
  process.exit(1);
}

if (!fs.existsSync(outPath)) {
  console.error(`  ✗ screenshot file missing after chromium returned 0`);
  process.exit(1);
}

const stat = fs.statSync(outPath);
console.log(`  ✓ captured (${(stat.size / 1024).toFixed(1)} KB)`);

// ── Trim trailing whitespace via ffmpeg cropdetect ──────────────────────────
//
// cropdetect scans for the bounding box of non-background pixels. Run it on
// the still image (one frame) and parse the suggested crop= line. If
// detection fails, we fall back to the raw 8000px image and the assembler
// will pan over it as-is (trailing whitespace at the end of the video).
const probe = spawnSync(
  "ffmpeg",
  [
    "-v", "info",
    "-i", outPath,
    "-vf", "cropdetect=limit=240:round=2:reset=0",
    "-frames:v", "1",
    "-f", "null", "-",
  ],
  { encoding: "utf8" },
);
const probeText = `${probe.stderr || ""}${probe.stdout || ""}`;
const m = probeText.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
if (m) {
  const cropW = parseInt(m[1], 10);
  const cropH = parseInt(m[2], 10);
  console.log(`  detected content bounds: ${cropW}×${cropH}`);

  // Re-encode with the detected crop so the assembler reads a clean image.
  const trimmedPath = path.join(screensDir, "report-full-trimmed.png");
  const trim = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", outPath,
      "-vf", `crop=${cropW}:${cropH}:${m[3]}:${m[4]}`,
      "-frames:v", "1",
      trimmedPath,
    ],
    { stdio: "inherit" },
  );
  if (trim.status === 0 && fs.existsSync(trimmedPath)) {
    fs.renameSync(trimmedPath, outPath);
    console.log(`  ✓ trimmed to ${cropW}×${cropH}`);
  } else {
    console.warn(`  ⚠ trim failed — using raw 1080×8000 image`);
  }
} else {
  console.warn(`  ⚠ cropdetect produced no crop=... line — using raw image`);
}

// Sanity-check final dimensions for the assembler.
const finalProbe = spawnSync(
  "ffprobe",
  [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    outPath,
  ],
  { encoding: "utf8" },
);
const [finalW, finalH] = (finalProbe.stdout || "").trim().split(",").map((n) => parseInt(n, 10));
console.log(`✓ report-full.png ready: ${finalW}×${finalH}`);

// Sidecar manifest so the assembler doesn't have to ffprobe again.
fs.writeFileSync(
  path.join(screensDir, "report-meta.json"),
  JSON.stringify({ width: finalW, height: finalH }, null, 2),
);
