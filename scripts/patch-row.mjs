// Patch a youtube_video_queue row with assembly result.
//
// Usage:
//   node scripts/patch-row.mjs <queue_id> --field value [--field value ...]
//   node scripts/patch-row.mjs <queue_id> --status pending_review --video_url URL --thumbnail_url URL --duration_sec 32.5
//   node scripts/patch-row.mjs <queue_id> --status error --error_message "ffmpeg returned 137"
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const queueId = args[0];
if (!queueId) {
  console.error("Usage: patch-row.mjs <queue_id> --field value [...]");
  process.exit(1);
}

const NUMERIC_FIELDS = new Set(["duration_sec", "view_count_24h"]);
const update = {};
for (let i = 1; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, "");
  const val = args[i + 1];
  if (!key || val === undefined) continue;
  update[key] = NUMERIC_FIELDS.has(key) ? Number(val) : val;
}

if (Object.keys(update).length === 0) {
  console.error("No fields to update");
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const { error } = await supabase
  .from("youtube_video_queue")
  .update(update)
  .eq("id", queueId);

if (error) {
  console.error(`patch failed: ${error.message}`);
  process.exit(1);
}

console.log(`✓ patched row ${queueId}: ${JSON.stringify(update)}`);
