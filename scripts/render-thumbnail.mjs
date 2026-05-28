// Fetch the 1280×720 thumbnail from vetmyride.com/api/og/youtube-thumbnail
// for the current row. Writes to tmp/thumbnail.jpg.

import fs from "node:fs";
import path from "node:path";

const SITE_URL = process.env.SITE_URL ?? "https://vetmyride.com";
const row = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);

const url = `${SITE_URL}/api/og/youtube-thumbnail?slug=${encodeURIComponent(row.source_slug)}&format=${row.format}`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`thumbnail fetch failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const outPath = path.join(process.cwd(), "tmp", "thumbnail.jpg");
fs.writeFileSync(outPath, buf);
console.log(`✓ thumbnail.jpg (${(buf.length / 1024).toFixed(1)} KB)`);
