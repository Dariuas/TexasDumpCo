import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { sendEmail } from "./_shared/email";
import { optionalEnv } from "./_shared/env";

const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
// No 0/O/1/I so a number read over the phone is unambiguous.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeNumber(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `TXC-${s}`;
}

// Public: a contractor requests an account. No login is created. They get a
// contractor number immediately, but it carries no contractor pricing until an
// admin verifies the business and approves it.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const b = await readJson<Record<string, string>>(req);
  for (const f of ["company_name", "contact_name", "email", "phone"]) {
    if (!b[f]?.trim()) return badRequest(`${f} is required`);
  }
  if (!/^\S+@\S+\.\S+$/.test(b.email)) return badRequest("Valid email required");
  const db = supabaseAdmin();
  const email = b.email.trim().toLowerCase();

  const { data: existing } = await db.from("contractors").select("contractor_number,status").ilike("email", email).maybeSingle();
  if (existing) {
    return json({ contractor_number: existing.contractor_number, status: existing.status, existing: true });
  }

  let row: { contractor_number: string } | null = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const { data, error } = await db.from("contractors").insert({
      contractor_number: makeNumber(),
      company_name: b.company_name.trim(),
      contact_name: b.contact_name.trim(),
      email,
      phone: b.phone.trim(),
      license_info: b.license_info?.trim() || null,
    }).select("contractor_number").single();
    if (!error) row = data;
    else if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
  }
  if (!row) throw new Error("Could not generate a contractor number, please try again");

  await sendEmail(email, `Your Texas Dumpster Co contractor number ${row.contractor_number}`,
    `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
       <p>Hi ${esc(b.contact_name)}, thanks for signing up ${esc(b.company_name)}.</p>
       <p>Your contractor number is <strong style="font-size:20px">${row.contractor_number}</strong>.</p>
       <p>We verify every new contractor before contractor pricing turns on. We will email you when you are approved.</p>
     </div>`);
  const alertTo = optionalEnv("ADMIN_ALERT_EMAIL");
  if (alertTo) {
    await sendEmail(alertTo, `Contractor to approve — ${b.company_name}`,
      `<p><strong>${esc(b.company_name)}</strong> (${esc(b.contact_name)}, ${esc(b.phone)}, ${esc(email)}) requested contractor number ${row.contractor_number}.</p>
       <p>License / info: ${esc(b.license_info || "none given")}</p><p>Review in the admin under Contractors.</p>`);
  }
  return json({ contractor_number: row.contractor_number, status: "pending" });
});

// Abuse guard: per-IP limit, enforced by Netlify before the function runs.
export const config: Config = { rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
