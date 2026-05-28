# Persona

Format B (Walkthrough) requires ONE generated AI persona PNG locked as the
channel mascot. Generate once via Midjourney v6 / SDXL with a fixed seed.

Required files:

| File | Spec |
|---|---|
| `persona-front.png` | 1080×1920 (or larger), transparent background, mid-shot, neutral lighting |
| `persona-left.png` | Alt angle for variety, same person/clothing/lighting |

Prompt direction (locked per plan v2 expert review):
> Mid-30s "auction inspector" — clipboard, slightly-grizzled mechanic look,
> neutral studio lighting, mid-shot, looking forward, clean haircut, no
> branded clothing.

Generate 4 candidates, eyeball-select the most authoritative-but-not-corporate
one, commit. Don't re-generate after launch — consistency is the moat.

Wav2Lip lip-syncs the front PNG to the narration MP3. The output PNG sequence
gets PiP-composited bottom-right on report screenshots.

When the PNGs are added, remove the `assets/persona/*.png` line from
`.gitignore`.
