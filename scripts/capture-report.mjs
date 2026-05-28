// Format B (Walkthrough) helper: capture the 5 report sections as PNGs
// via headless Chrome (no Puppeteer dep — uses node's built-in fetch
// against a chromium binary loaded by GHA Actions).
//
// Actually we go simpler: ubuntu-latest has Chromium preinstalled, and
// we drive it via `--screenshot=` flag against
// vetmyride.com/m/<report_id>?capture=1&section=<name>. The capture mode
// adds a print-friendly stylesheet that hides chrome/nav and scrolls to
// the named section.
//
// Outputs: tmp/screens/section-{vehicle,title,damage,repair,verdict}.png

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

const sections = ["vehicle", "title", "damage", "repair", "verdict"];
const screensDir = path.join(process.cwd(), "tmp", "screens");
fs.mkdirSync(screensDir, { recursive: true });

// Pick chromium binary — Ubuntu actions runners have it at /usr/bin/chromium
const chromium = process.env.CHROMIUM_PATH ?? "chromium";

for (const section of sections) {
  const url = `${SITE_URL}/m/${reportId}?capture=1&section=${section}`;
  const outPath = path.join(screensDir, `section-${section}.png`);
  console.log(`Capturing ${section} → ${outPath}`);
  const res = spawnSync(chromium, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1080,1920",
    `--screenshot=${outPath}`,
    "--virtual-time-budget=5000",
    url,
  ], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`  ✗ chromium failed for ${section} (code ${res.status})`);
    process.exit(1);
  }
}

console.log(`✓ captured ${sections.length} sections`);
