// Fetch the 5 vertical Satori OVERLAY PNGs AND the auction photo set
// from vetmyride.com.
//
// Overlays are transparent 1080×1920 PNGs (one per beat).
// Photos come from /api/youtube/photos and are the actual canvas
// FFmpeg composites the overlays onto.
//
// Outputs:
//   tmp/overlays/overlay-{1..5}.png   — transparent text/badge/chip layers
//   tmp/photos/photo-{0..N}.jpg       — auction photos (1-15)
//   tmp/photos/manifest.json          — { photos: [...], fallback: bool }
//
// Env: SITE_URL (defaults to https://vetmyride.com)

import fs from "node:fs";
import path from "node:path";

const SITE_URL = process.env.SITE_URL ?? "https://vetmyride.com";

const rowJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);
const slug = rowJson.source_slug;
const format = rowJson.format;
const beatCount = rowJson.script_json?.beats?.length ?? 5;

if (!slug) {
  console.error("row.json has no source_slug");
  process.exit(1);
}

const overlaysDir = path.join(process.cwd(), "tmp", "overlays");
const photosDir = path.join(process.cwd(), "tmp", "photos");
fs.mkdirSync(overlaysDir, { recursive: true });
fs.mkdirSync(photosDir, { recursive: true });

// ── Fetch Satori overlays ──────────────────────────────────────────────────

const endpoint =
  format === "walkthrough"
    ? "youtube-walkthrough-slide"
    : "youtube-slide";

console.log(`Fetching ${beatCount} overlays from ${SITE_URL}/api/og/${endpoint}`);

for (let beat = 1; beat <= beatCount; beat++) {
  const url = `${SITE_URL}/api/og/${endpoint}?slug=${encodeURIComponent(slug)}&beat=${beat}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ✗ overlay ${beat}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(overlaysDir, `overlay-${beat}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ overlay ${beat} → ${outPath}  (${(buf.length / 1024).toFixed(1)} KB)`);
}

// ── Fetch report-card synthetic image (used as canvas for beats 4-5) ──────
//
// For Roast format, beats 1-3 show the auction photo and beats 4-5 show a
// styled "report mockup" so the viewer sees the product UI for 30%+ of
// runtime. Skipped for Walkthrough format (which captures real report).

let reportCardPath = null;
if (format === "roast") {
  console.log(`\nFetching report card from /api/og/youtube-report-card?slug=${slug}`);
  const cardUrl = `${SITE_URL}/api/og/youtube-report-card?slug=${encodeURIComponent(slug)}`;
  const cardRes = await fetch(cardUrl);
  if (cardRes.ok) {
    const buf = Buffer.from(await cardRes.arrayBuffer());
    reportCardPath = path.join(overlaysDir, "report-card.jpg");
    fs.writeFileSync(reportCardPath, buf);
    console.log(`  ✓ report card → ${reportCardPath}  (${(buf.length / 1024).toFixed(1)} KB)`);
  } else {
    console.warn(`  ⚠ report card fetch ${cardRes.status} — beats 4-5 will use auction photo`);
  }
}

// ── Fetch photo manifest ───────────────────────────────────────────────────

console.log(`\nFetching photo manifest from /api/youtube/photos?slug=${slug}`);
const photosUrl = `${SITE_URL}/api/youtube/photos?slug=${encodeURIComponent(slug)}`;
const photosRes = await fetch(photosUrl);
if (!photosRes.ok) {
  console.error(`  ✗ photos: ${photosRes.status} ${await photosRes.text()}`);
  process.exit(1);
}
const manifest = await photosRes.json();
console.log(`  ✓ manifest: ${manifest.photos.length} photo(s), fallback=${manifest.fallback}`);

// Cap to 8 photos max to keep ffmpeg input count reasonable.
const PHOTO_CAP = 8;
const photoUrls = manifest.photos.slice(0, PHOTO_CAP);

const downloadedPhotos = [];
for (let i = 0; i < photoUrls.length; i++) {
  const url = photoUrls[i];
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ⚠ photo ${i} skipped: ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const outPath = path.join(photosDir, `photo-${i}.jpg`);
    fs.writeFileSync(outPath, buf);
    downloadedPhotos.push({ index: i, path: outPath, size: buf.length });
    console.log(`  ✓ photo ${i} → ${outPath}  (${(buf.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.warn(`  ⚠ photo ${i} fetch failed: ${err.message}`);
  }
}

if (downloadedPhotos.length === 0) {
  console.error("No photos downloaded — assembly will fail without canvas");
  process.exit(1);
}

fs.writeFileSync(
  path.join(photosDir, "manifest.json"),
  JSON.stringify({
    photos: downloadedPhotos.map((p) => p.path),
    report_card: reportCardPath,
    count: downloadedPhotos.length,
    fallback: manifest.fallback,
  }, null, 2),
);

console.log(`\n✓ ${beatCount} overlays + ${downloadedPhotos.length} photos${reportCardPath ? " + report card" : ""} ready.`);
