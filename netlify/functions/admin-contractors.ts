import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { sendEmail } from "./_shared/email";
import { audit } from "./_shared/audit";

// List contractors with job counts; approve / reject / suspend; edit notes.
export default adminHandler("staff", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const { data, error } = await db.from("contractors").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const { data: jobs } = await db.from("bookings").select("contractor_id,amount_total_cents,status").not("contractor_id", "is", null);
    const stats = new Map<string, { jobs: number; spend: number }>();
    for (const j of jobs ?? []) {
      if (j.status === "canceled") continue;
      const s = stats.get(j.contractor_id) ?? { jobs: 0, spend: 0 };
      s.jobs += 1; s.spend += j.amount_total_cents;
      stats.set(j.contractor_id, s);
    }
    return json({ contractors: (data ?? []).map((c) => ({ ...c, jobs: stats.get(c.id)?.jobs ?? 0, spend_cents: stats.get(c.id)?.spend ?? 0 })) });
  }
  if (req.method !== "POST") return badRequest("GET or POST");
  const b = await readJson<{ id?: string; status?: string; admin_notes?: string }>(req);
  if (!b.id) return badRequest("id required");

  const patch: Record<string, unknown> = {};
  if (b.admin_notes !== undefined) patch.admin_notes = b.admin_notes;
  if (b.status) {
    if (!["pending", "approved", "rejected", "suspended"].includes(b.status)) return badRequest("bad status");
    patch.status = b.status;
    patch.approved_at = b.status === "approved" ? new Date().toISOString() : null;
  }
  const { data, error } = await db.from("contractors").update(patch).eq("id", b.id).select().single();
  if (error) throw new Error(error.message);
  await audit({ actor: user.email!, action: `contractor.${b.status ?? "update"}`, entity: "contractors", entityId: b.id });
  if (b.status === "approved") {
    await sendEmail(data.email, "You're approved — Texas Dumpster Co contractor pricing",
      `<p>Hi ${data.contact_name}, ${data.company_name} is approved. Use contractor number <strong>${data.contractor_number}</strong> when you book online (with this email address) to get contractor pricing.</p>`);
  }
  return json({ contractor: data });
});
