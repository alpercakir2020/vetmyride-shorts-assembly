// Re-synthesize TTS narration from the script in tmp/row.json. The row
// already has word_timestamps_json from the Vercel-side synthesis, but
// we re-run synthesis here to get the actual MP3 audio buffer (the row
// only stores timing metadata, not the audio itself — keeps the DB row
// small).
//
// Mirrors src/lib/youtube/tts.ts in the main repo. Re-implemented as pure
// .mjs so this repo has zero TypeScript build step.
//
// Usage:
//   node scripts/synthesize-tts.mjs
//
// Outputs: tmp/narration.mp3 and tmp/word-timestamps.json
//
// Env: GOOGLE_TTS_CREDENTIALS_B64, YOUTUBE_TTS_VOICE (optional, default
// en-US-Studio-Q)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TTS_ENDPOINT =
  "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VOICE = process.env.YOUTUBE_TTS_VOICE ?? "en-US-Studio-Q";
const DEFAULT_LANGUAGE = "en-US";

const row = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);
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

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
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
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function tokenize(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
    .split(/\s+/)
    .filter(Boolean);
}

function isStudioVoice(voice) {
  return /^en-[A-Z]{2}-Studio-/i.test(voice);
}

// Google TTS emits MP3 at 128 kbps by default → 16000 bytes/sec.
function estimateMp3DurationSec(buf) {
  return buf.length / 16000;
}

function buildBeatSsml(beat) {
  const words = tokenize(beat.copy);
  if (words.length === 0) return "";
  const emphasisStart = Math.max(0, words.length - 3);
  const parts = [];
  for (let i = 0; i < words.length; i++) {
    parts.push(`<mark name="w_${beat.id}_${i}"/>`);
    if (i === emphasisStart) parts.push('<emphasis level="strong">');
    parts.push(words[i]);
    if (i < words.length - 1) parts.push(" ");
  }
  parts.push("</emphasis>");
  parts.push('<break time="400ms"/>');
  parts.push(`<mark name="w_${beat.id}_end"/>`);
  return parts.join("");
}

function buildFullSsml(beats) {
  const body = beats
    .map((b) => `<s>${buildBeatSsml(b)}</s>`)
    .join('<break time="120ms"/>');
  return `<speak>${body}</speak>`;
}

const token = await getAccessToken();
const tmpDir = path.join(process.cwd(), "tmp");

let audio, per_beat, totalDuration;
const useStudioPath = isStudioVoice(DEFAULT_VOICE);

if (useStudioPath) {
  // Studio voices reject SSML markup — synth each beat as plain text,
  // estimate per-word timing proportionally from MP3 byte size.
  const beatBuffers = [];
  const beatDurations = [];
  for (const beat of beats) {
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text: beat.copy },
        voice: { languageCode: DEFAULT_LANGUAGE, name: DEFAULT_VOICE },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0 },
      }),
    });
    if (!res.ok) {
      console.error(`Studio synth failed for beat ${beat.id}: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const data = await res.json();
    const buf = Buffer.from(data.audioContent, "base64");
    beatBuffers.push(buf);
    beatDurations.push(estimateMp3DurationSec(buf));
  }
  audio = Buffer.concat(beatBuffers);

  let cumOffset = 0;
  per_beat = beats.map((beat, i) => {
    const dur = beatDurations[i];
    const words = tokenize(beat.copy);
    const charTotal = words.reduce((acc, w) => acc + w.length, 0) || 1;
    let runningChars = 0;
    const ws = words.map((word) => {
      const startInBeat = (runningChars / charTotal) * dur;
      runningChars += word.length;
      return { word, time_sec: +(cumOffset + startInBeat).toFixed(3) };
    });
    const endSec = cumOffset + dur;
    const entry = { beat_id: beat.id, words: ws, end_sec: +endSec.toFixed(3) };
    cumOffset = endSec;
    return entry;
  });
  totalDuration = +cumOffset.toFixed(3);
} else {
  // Markable path — full SSML with <mark> word timepoints.
  const ssml = buildFullSsml(beats);
  const res = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { ssml },
      voice: { languageCode: DEFAULT_LANGUAGE, name: DEFAULT_VOICE },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0 },
      enableTimePointing: ["SSML_MARK"],
    }),
  });
  if (!res.ok) {
    console.error(`TTS failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  audio = Buffer.from(data.audioContent, "base64");
  const timepoints = data.timepoints ?? [];
  per_beat = beats.map((beat) => {
    const beatPoints = timepoints
      .filter((t) => t.markName.startsWith(`w_${beat.id}_`))
      .filter((t) => !t.markName.endsWith("_end"))
      .map((t) => {
        const idx = Number(t.markName.split("_").pop());
        const word = tokenize(beat.copy)[idx] ?? "";
        return { word, time_sec: t.timeSeconds };
      })
      .sort((a, b) => a.time_sec - b.time_sec);
    const endMark = timepoints.find((t) => t.markName === `w_${beat.id}_end`);
    return {
      beat_id: beat.id,
      words: beatPoints,
      end_sec: endMark?.timeSeconds ?? 0,
    };
  });
  totalDuration =
    timepoints.length > 0
      ? Math.max(...timepoints.map((t) => t.timeSeconds))
      : 0;
}

fs.writeFileSync(path.join(tmpDir, "narration.mp3"), audio);
fs.writeFileSync(
  path.join(tmpDir, "word-timestamps.json"),
  JSON.stringify({ per_beat, total_duration_sec: totalDuration }, null, 2),
);

console.log(`✓ narration.mp3 (${(audio.length / 1024).toFixed(1)} KB)`);
console.log(
  `✓ word-timestamps.json (${per_beat.reduce((a, b) => a + b.words.length, 0)} words, ${totalDuration.toFixed(2)}s, ${useStudioPath ? "Studio plain-text path" : "Markable SSML path"})`,
);
