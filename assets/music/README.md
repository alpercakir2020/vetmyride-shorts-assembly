# Music beds

Three 60-second background tracks at 90-95 BPM. Random selection per video
for variety. Beat-matched cut points are pre-calibrated in
`scripts/music-cues.mjs` (one entry per track).

| File | Mood | Suggested source query |
|---|---|---|
| `bed-lofi-tense.mp3` | Lo-fi crime tension | "lofi suspense" on Uppbeat / Pixabay |
| `bed-doc-tense.mp3` | Documentary tension | "tense documentary" on Pixabay |
| `bed-electronic-dark.mp3` | Dark electronic | "dark electronic" on Pixabay |

90-95 BPM is the sweet spot — slow enough not to step on TTS pacing, fast
enough to drive beat-matched cuts. Normalize to -18 dB before committing
(assembler ducks another -6 dB on the CATCH beat).
