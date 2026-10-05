import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { sendEmail, adminAlertTo } from "./_shared/email";
import { optionalEnv } from "./_shared/env";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));

// Public: homepage quote request, with optional photos already uploaded through
// upload-url (private bucket). Stored for the admin and emailed to the owner.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const b = await readJson<Record<string, any>>(req);
  if (b["bot-field"]) return json({ ok: true }); // honeypot
  for (const f of ["name", "phone", "email"]) if (!String(b[f] ?? "").trim()) return badRequest(`${f} is required`);
  if (!/^\S+@\S+\.\S+$/.test(b.email)) return badRequest("Valid email required");

  // Only accept paths our upload-url function issues, capped at 8.
  const photos: string[] = (Array.isArray(b.photos) ? b.photos : [])
    .filter((p: unknown) => typeof p === "string" && /^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/.test(p))
    .slice(0, 8);

  const { data, error } = await supabaseAdmin().from("quote_requests").insert({
    name: b.name.trim().slice(0, 120), phone: b.phone.trim().slice(0, 40), email: b.email.trim().slice(0, 160),
    service: b.service?.slice(0, 120) ?? null, zip: b.zip?.slice(0, 12) ?? null,
    details: b.details?.slice(0, 4000) ?? null, referral_source: b.heard_from?.slice(0, 80) || null,
    photo_paths: photos,
  }).select("id").single();
  if (error) throw new Error(error.message);

  const alertTo = await adminAlertTo();
  if (alertTo) {
    await sendEmail(alertTo, `Quote request — ${b.name}${photos.length ? ` (${photos.length} photo${photos.length > 1 ? "s" : ""})` : ""}`,
      `<div style="font-family:Arial,sans-serif"><h2>New quote request</h2><ul>
        <li><strong>${esc(b.name)}</strong> · ${esc(b.phone)} · ${esc(b.email)}</li>
        <li>Service: ${esc(b.service)} · ZIP ${esc(b.zip)}</li>
        <li>Heard about us: ${esc(b.heard_from || "—")}</li></ul>
        <p>${esc(b.details)}</p><p>${photos.length} photo(s) attached — view them in the admin under Quote Requests.</p></div>`);
  }
  return json({ ok: true, id: data.id });
});

// Abuse guard: per-IP limit, enforced by Netlify before the function runs.
export const config: Config = { rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
