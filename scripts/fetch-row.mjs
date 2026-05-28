// Fetch a youtube_video_queue row from Supabase by id and write it to
// tmp/row.json. Subsequent steps in the assembly pipeline read it from
// there to avoid passing huge JSON blobs through shell args.
//
// Usage:
//   node scripts/fetch-row.mjs <queue_id>
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const queueId = process.argv[2];
if (!queueId) {
  console.error("Usage: fetch-row.mjs <queue_id>");
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

const { data, error } = await supabase
  .from("youtube_video_queue")
  .select("*")
  .eq("id", queueId)
  .maybeSingle();

if (error || !data) {
  console.error(`row not found: ${error?.message ?? "no data"}`);
  process.exit(1);
}

const tmpDir = path.join(process.cwd(), "tmp");
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, "row.json"), JSON.stringify(data, null, 2));

console.log(`✓ fetched row ${queueId}`);
console.log(`  format: ${data.format}`);
console.log(`  source: ${data.source_type}/${data.source_slug}`);
console.log(`  status: ${data.status}`);
console.log(`  beats: ${data.script_json?.beats?.length ?? 0}`);
