// Pre-calibrated beat-cut points per music bed track. The assembler
// snaps slide-change times to the nearest cue so visual cuts feel
// beat-matched without runtime onset detection.
//
// To recalibrate after replacing a track:
//   1. Load track in a DAW or `ffplay`
//   2. Tap quarter-note positions in seconds
//   3. Update the array below
//
// Tracks live in assets/music/. The 3 we committed:
//   bed-1.mp3 — "tense" cinematic (Pixabay: nastelbom-tense)
//   bed-2.mp3 — crime documentary (Pixabay: lemonmusiclab-crime-documentary)
//   bed-3.mp3 — battle/action (Pixabay: cfl_turningpages-battle-on-route-30)
//
// All three are ~90-95 BPM. The cue arrays below are quarter-note grids
// (not measured against the actual onsets — close enough for visual cuts
// to feel beat-aligned).

export const MUSIC_TRACKS = [
  {
    file: "bed-1.mp3",
    bpm: 92,
    cues: Array.from({ length: 64 }, (_, i) => +(i * 0.652).toFixed(3)),
  },
  {
    file: "bed-2.mp3",
    bpm: 90,
    cues: Array.from({ length: 64 }, (_, i) => +(i * 0.667).toFixed(3)),
  },
  {
    file: "bed-3.mp3",
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
