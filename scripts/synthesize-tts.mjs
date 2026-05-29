// Synthesize TTS narration from the script in tmp/row.json.
//
// v15 STRUCTURAL REWRITE — the verdict moment is now a SEPARATE audio clip,
// not a guessed window inside one big narration file. This kills the entire
// class of "verdict gets clipped / covered by music / cut off at the end"
// bugs that 14 prior versions chased with envelope tweaks.
//
// What we emit:
//   tmp/narration.mp3              full-script concat (walkthrough back-compat)
//   tmp/tts/beat-0.mp3 … beat-2    HOOK / SETUP / CATCH voice clips
//   tmp/tts/beat-3-math.mp3        VERDICT beat WITHOUT the verdict word (if any)
//   tmp/tts/verdict.mp3            the verdict word ALONE ("Walk." / "Pass.")
//   tmp/word-timestamps.json       per-beat visual windows (drives overlays)
//   tmp/audio-segments.json        deterministic audio-build manifest (drives
//                                  assemble-roast.mjs's audio pre-pass)
//
// Durations are measured with ffprobe (actual decoded length) — NOT estimated
// from MP3 byte size, which was the root cause of the verdict-position drift.
//
// Voice path: plain text per beat. Studio voices reject SSML and we no longer
// burn karaoke captions, so the old SSML/<mark> branch is gone entirely.
//
// Env: GOOGLE_TTS_CREDENTIALS_B64, YOUTUBE_TTS_VOICE (default en-US-Studio-Q)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TTS_ENDPOINT =
  "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VOICE = process.env.YOUTUBE_TTS_VOICE ?? "en-US-Studio-Q";
const DEFAULT_LANGUAGE = "en-US";

// ── Audio-structure constants (the contract the assembler relies on) ─────────
// These are the ONLY knobs for verdict pacing. Because the audio is built by
// explicit concatenation of measured clips, changing them can never reintroduce
// the clip/cover/cutoff bugs — the verdict word's position is always exact.
const PRE_ROLL_SEC = 0.5; // clean photo before first word
const INTER_BEAT_GAP_SEC = 0.1; // breath between body beats
const VERDICT_PRE_SILENCE_SEC = 0.45; // dead air before the verdict word (music gone)
const VERDICT_POST_SILENCE_SEC = 0.95; // let the word ring, then fade

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const ttsDir = path.join(tmpDir, "tts");
fs.mkdirSync(ttsDir, { recursive: true });

const row = JSON.parse(fs.readFileSync(path.join(tmpDir, "row.json"), "utf8"));
const beats = row.script_json?.beats ?? [];
if (beats.length === 0) {
  console.error("row has no script beats");
  process.exit(1);
}

const b64 = process.env.GOOGLE_TTS_CREDENTIALS_B64;
if (!b64) {
  console.error("GOOGLE_TTS_CREDENTIALS_B64 not set");
  process.exit(1);
}
const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

// ── GCP service-account JWT → access token ───────────────────────────────────

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: creds.token_uri ?? TOKEN_ENDPOINT,
      exp,
      iat,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = b64url(signer.sign(creds.private_key));
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch(creds.token_uri ?? TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok)
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── One plain-text synth call → Buffer ───────────────────────────────────────

async function synthOne(token, text) {
  const res = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: DEFAULT_LANGUAGE, name: DEFAULT_VOICE },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0 },
    }),
  });
  if (!res.ok) {
    throw new Error(`TTS synth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return Buffer.from(data.audioContent, "base64");
}

// ── ffprobe → actual decoded duration (seconds) ──────────────────────────────

function probeDuration(file) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ],
    { encoding: "utf8" },
  );
  const d = parseFloat(String(r.stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

// ── Verdict-word split ───────────────────────────────────────────────────────
//
// script-gen enforces that the VERDICT beat ends with a single short verdict
// sentence ("Walk." "Pass." "Cooked."). We split it off so it becomes its own
// audio clip — the climax — with controlled silence around it. Everything
// before it (the ACV / max-bid / repair math) stays in the body.

function splitVerdict(copy) {
  const trimmed = (copy ?? "").trim();
  // Split into sentences on terminal punctuation.
  const sentences = trimmed.match(/[^.!?]+[.!?]+|\S+$/g) ?? [trimmed];
  if (sentences.length >= 2) {
    const verdict = sentences[sentences.length - 1].trim();
    const math = sentences.slice(0, -1).join(" ").trim();
    return { mathText: math, verdictText: verdict };
  }
  // Single sentence. If it's short, the whole thing is the verdict; otherwise
  // peel the last word.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 3) {
    return { mathText: "", verdictText: trimmed };
  }
  return {
    mathText: words.slice(0, -1).join(" "),
    verdictText: words[words.length - 1],
  };
}

// ── Synthesize ───────────────────────────────────────────────────────────────

const token = await getAccessToken();

// Beat indices: 0=hook 1=setup 2=catch 3=verdict 4=cta (roast & walkthrough
// both put the verdict at index 3). Guard for short scripts.
const VERDICT_IDX = beats.findIndex((b) => b.id === "verdict");
const verdictIdx = VERDICT_IDX >= 0 ? VERDICT_IDX : Math.min(3, beats.length - 1);

// Synthesize every beat as its own clip.
const beatBuffers = [];
for (let i = 0; i < beats.length; i++) {
  if (i === verdictIdx) {
    beatBuffers.push(null); // filled below after split
    continue;
  }
  beatBuffers.push(await synthOne(token, beats[i].copy));
}

// Split the verdict beat → math clip (optional) + verdict-word clip.
const { mathText, verdictText } = splitVerdict(beats[verdictIdx].copy);
const mathBuf = mathText ? await synthOne(token, mathText) : null;
const verdictBuf = await synthOne(token, verdictText);
// For narration.mp3 (full-script back-compat) the verdict slot is math+word.
beatBuffers[verdictIdx] = Buffer.concat(
  [mathBuf, verdictBuf].filter(Boolean),
);

// ── Write clip files (roast audio pre-pass consumes these) ───────────────────

const bodyClipPaths = [];
const bodyDurations = [];
// Body = every beat BEFORE the verdict (hook, setup, catch) + the verdict math.
for (let i = 0; i < verdictIdx; i++) {
  const p = path.join(ttsDir, `beat-${i}.mp3`);
  fs.writeFileSync(p, beatBuffers[i]);
  bodyClipPaths.push(p);
  bodyDurations.push(probeDuration(p));
}
let mathDuration = 0;
if (mathBuf) {
  const mathPath = path.join(ttsDir, "beat-3-math.mp3");
  fs.writeFileSync(mathPath, mathBuf);
  mathDuration = probeDuration(mathPath);
  bodyClipPaths.push(mathPath);
  bodyDurations.push(mathDuration);
}
const verdictPath = path.join(ttsDir, "verdict.mp3");
fs.writeFileSync(verdictPath, verdictBuf);
const verdictDuration = probeDuration(verdictPath);

// ── narration.mp3 — full-script concat (walkthrough still uses this) ─────────

const narrationPath = path.join(tmpDir, "narration.mp3");
fs.writeFileSync(narrationPath, Buffer.concat(beatBuffers));

// ── Visual beat windows (content time, starts at 0) ──────────────────────────
//
// These drive the overlay + photo timeline in assemble-roast.mjs. The
// assembler shifts them by PRE_ROLL when compositing. The verdict visual
// window deliberately spans math + pre-silence + the verdict word so the
// report card is on screen through the entire climax; the CTA window is the
// post-verdict tail hold.

const G = INTER_BEAT_GAP_SEC;
const perBeat = [];
let cursor = 0;
for (let i = 0; i < beats.length; i++) {
  let dur;
  if (i < verdictIdx) {
    dur = bodyDurations[i] + G;
  } else if (i === verdictIdx) {
    // The gap before the verdict math is owned by the catch beat's trailing
    // pad (every body beat carries +G). So the verdict window is exactly
    // math + pre-silence + verdict word — NO extra leading gap, or it
    // desyncs from the concatenated audio by one INTER_BEAT_GAP.
    dur = mathDuration + VERDICT_PRE_SILENCE_SEC + verdictDuration;
  } else {
    // CTA / tail — visual hold only, no narration
    dur = VERDICT_POST_SILENCE_SEC;
  }
  const start = cursor;
  const end = cursor + dur;
  perBeat.push({ beat_id: beats[i].id, words: [], end_sec: +end.toFixed(3) });
  cursor = end;
}
const contentTotal = +cursor.toFixed(3);
const totalDuration = +(PRE_ROLL_SEC + contentTotal).toFixed(3);

fs.writeFileSync(
  path.join(tmpDir, "word-timestamps.json"),
  JSON.stringify(
    { per_beat: perBeat, total_duration_sec: contentTotal },
    null,
    2,
  ),
);

// ── Audio-build manifest (the deterministic contract) ────────────────────────
//
// catch_window / body_end are in CONTENT time (no pre-roll). The assembler
// adds PRE_ROLL when it places music ducking + the verdict thump.

const catchIdx = beats.findIndex((b) => b.id === "catch");
const setupEnd = catchIdx > 0 ? perBeat[catchIdx - 1].end_sec : 0;
const catchEnd = catchIdx >= 0 ? perBeat[catchIdx].end_sec : contentTotal;
// Body ends (music must be gone) right where the verdict pre-silence begins.
const bodyEndContent =
  perBeat[verdictIdx].end_sec - VERDICT_PRE_SILENCE_SEC - verdictDuration;

fs.writeFileSync(
  path.join(tmpDir, "audio-segments.json"),
  JSON.stringify(
    {
      pre_roll_sec: PRE_ROLL_SEC,
      inter_beat_gap_sec: G,
      verdict_pre_silence_sec: VERDICT_PRE_SILENCE_SEC,
      verdict_post_silence_sec: VERDICT_POST_SILENCE_SEC,
      body_clips: bodyClipPaths,
      body_durations: bodyDurations,
      // Trailing silence to append after each body clip. hook/setup/catch each
      // carry one INTER_BEAT_GAP; the verdict-math clip carries none (the
      // verdict pre-silence follows it). The assembler applies these verbatim —
      // it never reconstructs gap placement, so audio + visual windows can't
      // drift apart. Sum of (body_durations[i] + body_gap_durs[i]) ===
      // body_end_content by construction.
      body_gap_durs: bodyClipPaths.map((p) => (p.includes("beat-3-math") ? 0 : G)),
      verdict_clip: verdictPath,
      verdict_duration_sec: +verdictDuration.toFixed(3),
      verdict_word: verdictText,
      catch_window_content: [+setupEnd.toFixed(3), +catchEnd.toFixed(3)],
      body_end_content: +bodyEndContent.toFixed(3),
      // Assembled-timeline offset where the verdict word begins (after pre-roll
      // + body + pre-silence). The thump fires 50ms before this; music is gone.
      verdict_word_start_sec: +(
        PRE_ROLL_SEC +
        bodyEndContent +
        VERDICT_PRE_SILENCE_SEC
      ).toFixed(3),
      content_total_sec: contentTotal,
      total_duration_sec: totalDuration,
    },
    null,
    2,
  ),
);

console.log(
  `✓ narration.mp3 (${(fs.statSync(narrationPath).size / 1024).toFixed(1)} KB, full script)`,
);
console.log(
  `✓ ${bodyClipPaths.length} body clip(s) + verdict.mp3 — verdict word: "${verdictText}" (${verdictDuration.toFixed(2)}s)`,
);
console.log(
  `✓ audio-segments.json — content ${contentTotal.toFixed(2)}s, total ${totalDuration.toFixed(2)}s, body ends ${bodyEndContent.toFixed(2)}s`,
);
