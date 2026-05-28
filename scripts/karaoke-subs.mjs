// Convert word_timestamps_json + script beats into an ASS (SubStation
// Alpha) subtitle file with karaoke \k tags. Each word becomes its own
// timed dialogue event so the active word highlights yellow while the
// rest stays white.
//
// ffmpeg burns this in via `-vf subtitles=tmp/karaoke.ass:fontsdir=assets/fonts/`
// (libass renderer required; ffmpeg ships with it on ubuntu-latest).
//
// Usage:
//   node scripts/karaoke-subs.mjs
//
// Outputs: tmp/karaoke.ass (input: tmp/row.json + tmp/word-timestamps.json)

import fs from "node:fs";
import path from "node:path";

const row = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);
const wts = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "tmp", "word-timestamps.json"),
    "utf8",
  ),
);

// ── ASS header ───────────────────────────────────────────────────────────────
//
// Style notes:
//   • PrimaryColour = white (inactive word)
//   • SecondaryColour = yellow (active word during karaoke fill)
//   • OutlineColour = black, BorderStyle=1 = outline+drop shadow
//   • Alignment 2 = bottom-center
//   • MarginV 180 = ~bottom-third (1080×1920 canvas)
//   • DejaVu Sans Bold at 64pt — pre-installed on Ubuntu GHA runners so
//     we skip the font-file commit. If we want Komika Axis later, drop
//     the TTF in assets/fonts/ and swap the style name below.
//
// ASS colors are &HBBGGRR — BGR + alpha.

const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption, DejaVu Sans, 64, &H00FFFFFF, &H0000FFFF, &H00000000, &H00000000, -1, 0, 1, 4, 2, 2, 60, 60, 180, 1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
`;

// ── Build word-by-word dialogue events ──────────────────────────────────────
//
// Strategy: for each beat, group words into ~3-4-word phrases. Each phrase
// becomes one Dialogue line with \k karaoke tags marking each word's
// duration in centiseconds. That triggers the yellow-fill animation.

function fmtTime(seconds) {
  if (seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${s.padStart(5, "0")}`;
}

const PHRASE_LEN = 4;
const lines = [];
for (const beat of wts.per_beat) {
  const words = beat.words ?? [];
  if (words.length === 0) continue;
  const endSec = beat.end_sec ?? words[words.length - 1].time_sec + 0.4;

  for (let i = 0; i < words.length; i += PHRASE_LEN) {
    const phrase = words.slice(i, i + PHRASE_LEN);
    const start = phrase[0].time_sec;
    const nextWordTime =
      i + PHRASE_LEN < words.length
        ? words[i + PHRASE_LEN].time_sec
        : endSec;
    const end = nextWordTime;
    const durSec = Math.max(0.1, end - start);
    const totalCs = Math.floor(durSec * 100);

    // Distribute karaoke timing across the words in the phrase
    let text = "";
    for (let j = 0; j < phrase.length; j++) {
      const wordStart = phrase[j].time_sec - start;
      const wordEnd =
        j + 1 < phrase.length
          ? phrase[j + 1].time_sec - start
          : durSec;
      const wordCs = Math.max(1, Math.floor((wordEnd - wordStart) * 100));
      text += `{\\k${wordCs}}${escapeAss(phrase[j].word)} `;
    }
    text = text.trimEnd();
    // Cap excessive duration
    const capEnd = start + Math.min(durSec, totalCs / 100);
    lines.push(
      `Dialogue: 0,${fmtTime(start)},${fmtTime(capEnd)},Caption,,0,0,0,,${text}`,
    );
  }
}

function escapeAss(s) {
  // Escape special ASS characters
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

const ass = header + lines.join("\n") + "\n";
const outPath = path.join(process.cwd(), "tmp", "karaoke.ass");
fs.writeFileSync(outPath, ass);

console.log(`✓ karaoke.ass (${lines.length} phrase events)`);
