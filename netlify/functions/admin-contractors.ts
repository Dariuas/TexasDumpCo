import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { sendEmail, esc } from "./_shared/email";
import { audit } from "./_shared/audit";
import { ensureNumber, phoneDigits } from "./_shared/contractors";

const BUCKET = "booking-uploads";
const CERT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

interface Body {
  id?: string;
  action?: "update" | "cert_upload_url" | "cert_attach" | "cert_view";
  status?: string;
  admin_notes?: string;
  company_name?: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  license_info?: string;
  tax_exempt?: boolean;
  tax_exempt_cert?: string;
  filename?: string;
  content_type?: string;
  path?: string;
}

// Contractors: accounts with job counts, the verification/request queue, approve
// (assigns the contractor number) / reject / suspend, edit details, tax exemption
// and the exemption certificate on file.
export default adminHandler("staff", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const [{ data, error }, { data: jobs }, { data: quotes }, { data: queueBookings }] = await Promise.all([
      db.from("contractors").select("*").order("created_at", { ascending: false }),
      db.from("bookings").select("id,reference,contractor_id,amount_total_cents,status,start_date,payment_status").not("contractor_id", "is", null).order("start_date", { ascending: false }),
      db.from("quote_requests").select("id,name,phone,email,service,delivery_address,details,status,contractor_id,is_contractor,booking_id,created_at").eq("is_contractor", true).order("created_at", { ascending: false }).limit(300),
      db.from("bookings").select("id,reference,customer_name,customer_phone,customer_email,delivery_address,start_date,end_date,status,payment_status,amount_total_cents,flags,contractor_id,created_at,dumpster_types(name)")
        .eq("status", "pending").contains("flags", ["contractor_request"]).order("created_at", { ascending: false }),
    ]);
    if (error) throw new Error(error.message);
    const stats = new Map<string, { jobs: number; spend: number }>();
    for (const j of jobs ?? []) {
      if (j.status === "canceled") continue;
      const s = stats.get(j.contractor_id) ?? { jobs: 0, spend: 0 };
      s.jobs += 1; s.spend += j.amount_total_cents;
      stats.set(j.contractor_id, s);
    }
    const quoteCount = new Map<string, number>();
    for (const q of quotes ?? []) if (q.contractor_id) quoteCount.set(q.contractor_id, (quoteCount.get(q.contractor_id) ?? 0) + 1);
    return json({
      contractors: (data ?? []).map((c) => ({
        ...c, jobs: stats.get(c.id)?.jobs ?? 0, spend_cents: stats.get(c.id)?.spend ?? 0, quotes: quoteCount.get(c.id) ?? 0,
      })),
      bookings: jobs ?? [],
      quotes: quotes ?? [],
      queue_bookings: queueBookings ?? [],
    });
  }
  if (req.method !== "POST") return badRequest("GET or POST");
  const b = await readJson<Body>(req);
  if (!b.id) return badRequest("id required");
  const { data: cur } = await db.from("contractors").select("*").eq("id", b.id).maybeSingle();
  if (!cur) return notFound("Contractor not found");

  if (b.action === "cert_upload_url") {
    if (!b.filename) return badRequest("filename required");
    if (b.content_type && !CERT_TYPES.includes(b.content_type)) return badRequest("Upload a PDF or a photo of the certificate");
    const safe = b.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const path = `contractors/${cur.id}/${crypto.randomUUID()}-${safe}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return json({ path, token: data.token });
  }
  if (b.action === "cert_attach") {
    if (!b.path?.startsWith(`contractors/${cur.id}/`)) return badRequest("Bad certificate path");
    if (cur.tax_exempt_file && cur.tax_exempt_file !== b.path) await db.storage.from(BUCKET).remove([cur.tax_exempt_file]);
    const { data, error } = await db.from("contractors").update({ tax_exempt_file: b.path }).eq("id", cur.id).select().single();
    if (error) throw new Error(error.message);
    await audit({ actor: user.email!, action: "contractor.cert_upload", entity: "contractors", entityId: cur.id });
    return json({ contractor: data });
  }
  if (b.action === "cert_view") {
    if (!cur.tax_exempt_file) return badRequest("No certificate on file");
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(cur.tax_exempt_file, 600);
    if (error) throw new Error(error.message);
    return json({ url: data.signedUrl });
  }

  const patch: Record<string, unknown> = {};
  if (b.admin_notes !== undefined) patch.admin_notes = b.admin_notes;
  for (const k of ["company_name", "contact_name", "license_info", "tax_exempt_cert"] as const) {
    if (b[k] !== undefined) patch[k] = String(b[k] ?? "").trim() || (k === "company_name" || k === "contact_name" ? cur[k] : null);
  }
  if (b.email !== undefined) {
    const email = b.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return badRequest("Valid email required");
    patch.email = email;
  }
  if (b.phone !== undefined) {
    if (phoneDigits(b.phone).length < 10) return badRequest("Valid phone number required");
    patch.phone = b.phone.trim();
    patch.phone_digits = phoneDigits(b.phone);
  }
  if (b.tax_exempt !== undefined) patch.tax_exempt = !!b.tax_exempt;
  if (b.status) {
    if (!["pending", "approved", "rejected", "suspended"].includes(b.status)) return badRequest("bad status");
    patch.status = b.status;
    patch.approved_at = b.status === "approved" ? new Date().toISOString() : null;
    if (b.status === "approved") patch.verified_by = user.email;
  }
  const { data, error } = await db.from("contractors").update(patch).eq("id", b.id).select().single();
  if (error) throw new Error(/duplicate|unique/i.test(error.message) ? "Another contractor already uses that email" : error.message);

  let contractor = data;
  if (b.status === "approved") {
    const number = await ensureNumber(data.id);
    contractor = { ...data, contractor_number: number };
    await sendEmail(data.email, `You're approved — your Texas Dumpster Co contractor number is ${number}`,
      `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
         <p>Hi ${esc(data.contact_name)}, ${esc(data.company_name)} is approved for contractor pricing.</p>
         <p>Your contractor number is <strong style="font-size:20px">${esc(number)}</strong>.</p>
         <p>Use it when you book online or request a quote, together with this email address or the phone number on your account.</p>
       </div>`);
  }
  await audit({ actor: user.email!, action: `contractor.${b.status ?? "update"}`, entity: "contractors", entityId: b.id, detail: Object.keys(patch) });
  return json({ contractor });
});
