# vetmyride-shorts-assembly

GitHub Actions video-assembly worker for [VetMyRide](https://vetmyride.com)'s
autonomous YouTube Shorts pipeline. Public repo so the GHA runner pulls
unlimited free minutes on Ubuntu — needed because Vercel functions can't
host ffmpeg + Wav2Lip in the 250 MB unzipped limit, and Vercel Hobby crons
cap at 60s while Format B assembly takes 12-18 min.

## Architecture

```
Vercel cron /api/cron/youtube-daily
      │
      │ Generates script + TTS, inserts row in youtube_video_queue (status=script_ready)
      │ Triggers GHA workflow_dispatch with queue_id
      ▼
GitHub Actions youtube-shorts-assembly.yml  ← THIS REPO
      │
      ├─ fetch-row.mjs: pull row from Supabase
      ├─ Format A (Roast): render-slides → synthesize-tts → karaoke-subs → assemble-roast
      │ Format B (Walkthrough): screenshot-report → wav2lip → assemble-walkthrough
      ├─ upload-blob.mjs: push MP4 + thumbnail to Vercel Blob
      └─ patch-row.mjs: UPDATE youtube_video_queue SET status='pending_review', urls
      ▼
Vercel cron /api/cron/youtube-publish
      │ Direct REST to YouTube Data API v3 + comment + thumbnail
      ▼
@vetmyride channel
```

Full architectural plan lives in the main app repo at
`~/.claude/plans/i-also-want-to-mellow-cascade.md`.

## Triggering

Workflow_dispatch only — never on push. Trigger via the Vercel cron handler
(`POST /api/cron/youtube-daily`) which after staging a row calls:

```bash
curl -X POST \
  -H "Authorization: Bearer $WORKFLOW_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/alpercakir2020/vetmyride-shorts-assembly/actions/workflows/youtube-shorts-assembly.yml/dispatches \
  -d '{"ref":"main","inputs":{"queue_id":"<uuid>"}}'
```

You can also trigger manually from the Actions tab for smoke testing.

## Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Used by fetch-row + patch-row |
| `SUPABASE_SERVICE_KEY` | Service-role key (RLS bypass) |
| `BLOB_READ_WRITE_TOKEN` | Read-write token for video + thumbnail uploads (standard @vercel/blob env var) |
| `GOOGLE_TTS_CREDENTIALS_B64` | Re-synthesizes TTS in GHA (avoids double-storing audio) |
| `SITE_URL` | https://vetmyride.com — used by render-slides to hit the Satori endpoints |

## Local dev

```bash
npm install
node scripts/fetch-row.mjs <queue_id>
```

The full assembly chain requires ffmpeg + python3 (for Wav2Lip). Ubuntu
runners have both preinstalled; on macOS install via:

```bash
brew install ffmpeg python3
```

## Output

Each successful run uploads:
- `vetmyride-shorts/<row_id>.mp4` — 1080×1920 H.264, ~32s, ~5 MB
- `vetmyride-shorts/<row_id>-thumb.jpg` — 1280×720 thumbnail

And patches the corresponding `youtube_video_queue` row:
- `status='pending_review'`
- `video_url`, `thumbnail_url`, `duration_sec`, `gha_run_id`

On failure, patches `status='error'` + `error_message`.
