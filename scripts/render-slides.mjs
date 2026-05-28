// Fetch the 5 vertical Satori slides from vetmyride.com for the current
// queue row. Reads tmp/row.json (produced by fetch-row.mjs) and writes
// tmp/slides/slide-{1..5}.jpg.
//
// The Satori endpoint is rate-friendly (we hit it 5x, with cache headers
// allowing s-maxage=86400) and renders 1080×1920 JPEGs at ~50 KB each.
//
// Usage:
//   node scripts/render-slides.mjs
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

const slidesDir = path.join(process.cwd(), "tmp", "slides");
fs.mkdirSync(slidesDir, { recursive: true });

const endpoint =
  format === "walkthrough"
    ? "youtube-walkthrough-slide"
    : "youtube-slide";

console.log(`Fetching ${beatCount} slides from ${SITE_URL}/api/og/${endpoint}`);

for (let beat = 1; beat <= beatCount; beat++) {
  const url = `${SITE_URL}/api/og/${endpoint}?slug=${encodeURIComponent(slug)}&beat=${beat}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ✗ slide ${beat}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(slidesDir, `slide-${beat}.jpg`);
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ slide ${beat} → ${outPath}  (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log("All slides rendered.");
