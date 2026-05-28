// Format B (Walkthrough) video assembly.
//
// This is a Phase-1 STUB that produces a working video using static
// persona overlay rather than Wav2Lip lip-sync. Once persona PNG is
// committed and Wav2Lip is installed in the GHA workflow, the
// `runWav2Lip()` function will swap from no-op to real lip-sync.
//
// Inputs:
//   • tmp/row.json
//   • tmp/screens/section-*.png  (from capture-report.mjs)
//   • tmp/narration.mp3
//   • tmp/karaoke.ass
//   • assets/persona/persona-front.png (or fallback placeholder)
//
// Output: tmp/video.mp4

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const assetsDir = path.join(cwd, "assets");

const row = JSON.parse(fs.readFileSync(path.join(tmpDir, "row.json"), "utf8"));
const wts = JSON.parse(
  fs.readFileSync(path.join(tmpDir, "word-timestamps.json"), "utf8"),
);
const beats = row.script_json?.beats ?? [];
const sections = beats.map((b) => b.section_to_show ?? "verdict");

// Beat timings from TTS word-timestamps
const beatTimings = [];
let prevEnd = 0;
for (let i = 0; i < beats.length; i++) {
  const wtsBeat = wts.per_beat[i];
  const start = prevEnd;
  const end =
    wtsBeat?.end_sec ??
    wtsBeat?.words?.[wtsBeat.words.length - 1]?.time_sec + 0.4 ??
    start + 6;
  beatTimings.push({ start, end, duration: end - start, section: sections[i] });
  prevEnd = end;
}
const totalDuration = prevEnd;

// ── Wav2Lip stub ────────────────────────────────────────────────────────────
//
// Phase 1: skip lip-sync, just composite static persona PNG.
// Phase 2: this function will run python wav2lip/inference.py and return
//          path to lip-synced MP4 of just the persona face.

function runWav2Lip() {
  const personaPath = path.join(assetsDir, "persona", "persona-front.png");
  if (!fs.existsSync(personaPath)) {
    console.warn(`  ⚠ persona-front.png missing — using gradient placeholder`);
    return null;
  }
  console.log("  (Phase 1) skipping Wav2Lip, using static persona overlay");
  return personaPath;
}

const personaPath = runWav2Lip();
const hasKaraoke = fs.existsSync(path.join(tmpDir, "karaoke.ass")) && fs.existsSync(path.join(assetsDir, "fonts"));

// ── Build concat list of screenshot sections ────────────────────────────────

const concatList = path.join(tmpDir, "concat.txt");
const lines = beatTimings.map(
  (t) =>
    `file '${path.join(tmpDir, "screens", `section-${t.section}.png`)}'\nduration ${t.duration.toFixed(3)}`,
);
lines.push(`file '${path.join(tmpDir, "screens", `section-${beatTimings[beatTimings.length - 1].section}.png`)}'`);
fs.writeFileSync(concatList, lines.join("\n"));

// ── FFmpeg ──────────────────────────────────────────────────────────────────

const args = [
  "-y",
  "-f", "concat", "-safe", "0", "-i", concatList,
  "-i", path.join(tmpDir, "narration.mp3"),
];
if (personaPath) args.push("-loop", "1", "-i", personaPath);

const filters = [];
filters.push("[0:v]fps=30,scale=1080:1920:flags=lanczos,setsar=1[bg]");

let vmap = "[bg]";
if (personaPath) {
  // PiP avatar bottom-right, 35% width
  filters.push(
    "[2:v]scale=378:-1[avatar]",
    "[bg][avatar]overlay=W-w-30:H-h-30[vavatar]",
  );
  vmap = "[vavatar]";
}

if (hasKaraoke) {
  filters.push(
    `${vmap}subtitles=${path.join(tmpDir, "karaoke.ass")}:fontsdir=${path.join(assetsDir, "fonts")}[vsub]`,
  );
  vmap = "[vsub]";
}

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

console.log("ffmpeg " + args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
const res = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (res.status !== 0) {
  console.error(`ffmpeg failed with code ${res.status}`);
  process.exit(1);
}

fs.writeFileSync(path.join(tmpDir, "duration.txt"), totalDuration.toFixed(2));
console.log(`\n✓ tmp/video.mp4 assembled, duration ${totalDuration.toFixed(2)}s`);
