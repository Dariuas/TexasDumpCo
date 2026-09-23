import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

const BUCKET = "booking-uploads";
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// Issues a one-time signed upload URL into the private photo bucket so the
// browser can upload directly without ever seeing the service role key.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<{ filename?: string; content_type?: string }>(req);
  if (!body.filename) return badRequest("filename required");
  if (body.content_type && !ALLOWED.includes(body.content_type)) {
    return badRequest("Only image uploads are allowed");
  }

  const safe = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const path = `uploads/${crypto.randomUUID()}/${safe}`;

  const { data, error } = await supabaseAdmin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error(error.message);

  return json({ path, token: data.token, signedUrl: data.signedUrl });
});
