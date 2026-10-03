import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { checkChallenge } from "./_shared/agreement-verify";

// Public: early check of the emailed code so the customer finds out before the
// last step. create-booking re-verifies the same code server-side regardless.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { email, code, token } = await readJson<{ email?: string; code?: string; token?: string }>(req);
  if (!email || !code || !token || !checkChallenge(email, code, token)) return badRequest("Invalid or expired code");
  return json({ ok: true });
});
