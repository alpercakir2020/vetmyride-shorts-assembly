// Upload tmp/video.mp4 + tmp/thumbnail.jpg to Vercel Blob. Echoes the
// resulting public URLs to stdout for the GHA workflow to capture into
// outputs and pass to patch-row.
//
// Usage:
//   node scripts/upload-blob.mjs
//
// Env: BLOB_READ_WRITE_TOKEN (standard @vercel/blob env var name).

import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not set");
  process.exit(1);
}

const row = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tmp", "row.json"), "utf8"),
);
const rowId = row.id;

const videoPath = path.join(process.cwd(), "tmp", "video.mp4");
const thumbPath = path.join(process.cwd(), "tmp", "thumbnail.jpg");
if (!fs.existsSync(videoPath)) {
  console.error("tmp/video.mp4 not found — assembly step likely failed");
  process.exit(1);
}

const videoBuf = fs.readFileSync(videoPath);
const videoBlob = await put(`vetmyride-shorts/${rowId}.mp4`, videoBuf, {
  access: "public",
  contentType: "video/mp4",
  token,
  addRandomSuffix: false,
  allowOverwrite: true,
});
console.log(`✓ video uploaded → ${videoBlob.url}`);

let thumbUrl = "";
if (fs.existsSync(thumbPath)) {
  const thumbBuf = fs.readFileSync(thumbPath);
  const thumbBlob = await put(`vetmyride-shorts/${rowId}-thumb.jpg`, thumbBuf, {
    access: "public",
    contentType: "image/jpeg",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  thumbUrl = thumbBlob.url;
  console.log(`✓ thumbnail uploaded → ${thumbUrl}`);
}

// Emit machine-readable JSON for the workflow to parse
console.log(
  JSON.stringify({
    video_url: videoBlob.url,
    thumbnail_url: thumbUrl,
  }),
);
