# SFX library

Drop these 6 free SFX files here. All Pixabay / Mixkit assets are free for
commercial use, no attribution required, but verify license per asset.

Required files (filename → suggested source query):

| File | Sources to search |
|---|---|
| `whoosh.wav` | "whoosh transition" on Pixabay |
| `ka-ching.wav` | "cash register" on Mixkit |
| `buzzer.wav` | "wrong answer buzzer" on Pixabay |
| `alarm.wav` | "tense alarm short" on Mixkit |
| `glass-shatter.wav` | "glass break" on Pixabay |
| `record-scratch.wav` | "vinyl scratch" on Pixabay |

Keep each under 2 seconds and normalize to -6 dB before committing. Format A
assembler triggers them per-beat from `script_json.beats[N].sfx`.

When .wav files are added, also remove the `assets/sfx/*.wav` line from
`.gitignore` so they get committed.
