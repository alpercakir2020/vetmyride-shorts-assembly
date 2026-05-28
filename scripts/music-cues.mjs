// Pre-calibrated beat-cut points per music bed track. The assembler
// snaps slide-change times to the nearest cue so visual cuts feel
// beat-matched without runtime onset detection.
//
// To recalibrate after replacing a track:
//   1. Load track in a DAW or `ffplay`
//   2. Tap quarter-note positions in seconds
//   3. Update the array below
//
// Tracks are at 90-95 BPM, so quarter notes ≈ 0.63-0.67s apart. The
// assembler picks the track at random per video; the SAME track is used
// for the full 32s, and cuts snap to that track's cues.

export const MUSIC_TRACKS = [
  {
    file: "bed-lofi-tense.mp3",
    bpm: 92,
    // Quarter-note cues (seconds from start). 92 BPM = 0.652s/beat.
    // First 64 beats (~42s) — enough headroom for a 32s Short.
    cues: Array.from({ length: 64 }, (_, i) => +(i * 0.652).toFixed(3)),
  },
  {
    file: "bed-doc-tense.mp3",
    bpm: 90,
    cues: Array.from({ length: 64 }, (_, i) => +(i * 0.667).toFixed(3)),
  },
  {
    file: "bed-electronic-dark.mp3",
    bpm: 95,
    cues: Array.from({ length: 64 }, (_, i) => +(i * 0.632).toFixed(3)),
  },
];

/** Pick a track at random for a given video — keyed on row id for stability. */
export function pickTrack(rowId) {
  let hash = 0;
  for (const c of rowId) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const idx = Math.abs(hash) % MUSIC_TRACKS.length;
  return MUSIC_TRACKS[idx];
}

/** Snap a time (seconds) to the nearest cue in the given track. */
export function snapToBeat(track, timeSec) {
  let bestCue = track.cues[0];
  let bestDist = Math.abs(timeSec - bestCue);
  for (const cue of track.cues) {
    const d = Math.abs(timeSec - cue);
    if (d < bestDist) {
      bestDist = d;
      bestCue = cue;
    }
  }
  return bestCue;
}
