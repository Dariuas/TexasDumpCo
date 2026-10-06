import type { Config } from "@netlify/functions";
import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { sendEmail, adminAlertTo } from "./_shared/email";
import { findContractor, ensureApplication, phoneDigits } from "./_shared/contractors";

const esc = (s: string) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));

// Public: a contractor applies for an account. No login is created and no number
// is issued yet: the application waits in the admin Contractor queue, and the
// contractor number is assigned (and emailed) when an admin verifies and approves it.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const b = await readJson<Record<string, string>>(req);
  for (const f of ["company_name", "contact_name", "email", "phone"]) {
    if (!b[f]?.trim()) return badRequest(`${f} is required`);
  }
  if (!/^\S+@\S+\.\S+$/.test(b.email)) return badRequest("Valid email required");
  if (phoneDigits(b.phone).length < 10) return badRequest("Valid phone number required");
  const email = b.email.trim().toLowerCase();

  const existing = await findContractor({ email, phone: b.phone });
  if (existing) {
    // Only an approved account reveals its number; anything else just reports status.
    return json({
      status: existing.status, existing: true,
      contractor_number: existing.status === "approved" ? existing.contractor_number : null,
    });
  }

  await ensureApplication({ company_name: b.company_name, contact_name: b.contact_name, email, phone: b.phone, license_info: b.license_info });

  await sendEmail(email, "We received your Texas Dumpster Co contractor application",
    `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
       <p>Hi ${esc(b.contact_name)}, thanks for applying for a contractor account for ${esc(b.company_name)}.</p>
       <p>We verify every contractor before contractor pricing turns on. Once you're approved we'll email your contractor number.</p>
     </div>`);
  const alertTo = await adminAlertTo();
  if (alertTo) {
    await sendEmail(alertTo, `Contractor to verify — ${b.company_name}`,
      `<p><strong>${esc(b.company_name)}</strong> (${esc(b.contact_name)}, ${esc(b.phone)}, ${esc(email)}) applied for a contractor account.</p>
       <p>License / info: ${esc(b.license_info || "none given")}</p><p>Review it in the admin under Contractors → Queue.</p>`);
  }
  return json({ status: "pending" });
});

// Abuse guard: per-IP limit, enforced by Netlify before the function runs.
export const config: Config = { rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] } } as Config; // windowLimit postdates the installed @netlify/functions types
