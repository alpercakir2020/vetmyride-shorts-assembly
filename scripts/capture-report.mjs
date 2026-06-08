// Format B (Walkthrough) capture:
//
//   1. Full-page screenshot of the report at 1080 width (Chrome viewport
//      equals window-size — entire page renders in one shot). Trimmed via
//      ffmpeg cropdetect to remove trailing whitespace.
//   2. Auction photos from /api/youtube/photos?report_id=<id>. Used as
//      the opener segment so the viewer sees the actual car before the
//      report scroll starts. Solves the "visually empty" complaint.
//
// REVISION 2026-06-08 (S49 + photos fix): walkthrough was just a single
// scrolling screenshot. Adding photos gives the format a hook + a
// document feel.
//
// Outputs:
//   tmp/screens/report-full.png            (trimmed full-page report)
//   tmp/screens/report-meta.json           ({width, height, photo_count})
//   tmp/photos/photo-{0..N}.jpg            (auction photos, up to 5)

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
const photosDir = path.join(process.cwd(), "tmp", "photos");
fs.mkdirSync(screensDir, { recursive: true });
fs.mkdirSync(photosDir, { recursive: true });

// ── 1. Full-page report screenshot ─────────────────────────────────────────

const chromium = process.env.CHROMIUM_PATH ?? "chromium";
const url = `${SITE_URL}/m/${reportId}?capture=1`;
const reportPath = path.join(screensDir, "report-full.png");

console.log(`Capturing full report → ${reportPath}`);
console.log(`  URL: ${url}`);

const res = spawnSync(
  chromium,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1080,8000",
    `--screenshot=${reportPath}`,
    "--virtual-time-budget=12000",
    url,
  ],
  { stdio: "inherit" },
);

if (res.status !== 0) {
  console.error(`  ✗ chromium failed (code ${res.status})`);
  process.exit(1);
}
if (!fs.existsSync(reportPath)) {
  console.error(`  ✗ screenshot file missing after chromium returned 0`);
  process.exit(1);
}
console.log(`  ✓ captured (${(fs.statSync(reportPath).size / 1024).toFixed(1)} KB)`);

// Trim trailing whitespace via cropdetect.
const probe = spawnSync(
  "ffmpeg",
  [
    "-v", "info",
    "-i", reportPath,
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
  const trimmedPath = path.join(screensDir, "report-full-trimmed.png");
  const trim = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", reportPath,
      "-vf", `crop=${cropW}:${cropH}:${m[3]}:${m[4]}`,
      "-frames:v", "1",
      trimmedPath,
    ],
    { stdio: "inherit" },
  );
  if (trim.status === 0 && fs.existsSync(trimmedPath)) {
    fs.renameSync(trimmedPath, reportPath);
    console.log(`  ✓ trimmed to ${cropW}×${cropH}`);
  } else {
    console.warn(`  ⚠ trim failed — using raw 1080×8000 image`);
  }
} else {
  console.warn(`  ⚠ cropdetect produced no crop=... line — using raw image`);
}

const finalProbe = spawnSync(
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
const [reportW, reportH] = (finalProbe.stdout || "").trim().split(",").map((n) => parseInt(n, 10));
console.log(`✓ report-full.png ready: ${reportW}×${reportH}`);

// ── 2. Auction photos ──────────────────────────────────────────────────────
//
// Walkthrough source_slug is a report UUID. /api/youtube/photos?report_id=
// pulls from reports.photo_urls directly. Up to 5 photos cap matches the
// roast pipeline so the visual rotation feels familiar.

const PHOTO_CAP = 5;
const downloadedPhotos = [];
try {
  const photosUrl = `${SITE_URL}/api/youtube/photos?report_id=${encodeURIComponent(reportId)}`;
  console.log(`\nFetching auction photos from ${photosUrl}`);
  const photosRes = await fetch(photosUrl);
  if (!photosRes.ok) {
    console.warn(`  ⚠ photos endpoint ${photosRes.status} — walkthrough will skip the photo opener`);
  } else {
    const manifest = await photosRes.json();
    const urls = (manifest.photos ?? []).slice(0, PHOTO_CAP);
    for (let i = 0; i < urls.length; i++) {
      try {
        const dl = await fetch(urls[i]);
        if (!dl.ok) {
          console.warn(`  ⚠ photo ${i} skipped: ${dl.status}`);
          continue;
        }
        const buf = Buffer.from(await dl.arrayBuffer());
        const outPath = path.join(photosDir, `photo-${i}.jpg`);
        fs.writeFileSync(outPath, buf);
        downloadedPhotos.push(outPath);
        console.log(`  ✓ photo ${i} → ${(buf.length / 1024).toFixed(1)} KB`);
      } catch (err) {
        console.warn(`  ⚠ photo ${i} fetch failed: ${err.message}`);
      }
    }
  }
} catch (err) {
  console.warn(`  ⚠ photo fetch errored: ${err.message}`);
}

// ── Sidecar manifest ───────────────────────────────────────────────────────

fs.writeFileSync(
  path.join(screensDir, "report-meta.json"),
  JSON.stringify(
    {
      width: reportW,
      height: reportH,
      photo_count: downloadedPhotos.length,
      photos: downloadedPhotos,
    },
    null,
    2,
  ),
);

console.log(
  `\n✓ Walkthrough assets ready — report ${reportW}×${reportH} + ${downloadedPhotos.length} photo(s)`,
);
