import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { audit } from "./_shared/audit";

export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { booking_id, action } = await readJson<{ booking_id?: string; action?: "charge" | "waive" }>(req);
  if (!booking_id || (action !== "charge" && action !== "waive")) return badRequest("booking_id and action required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*").eq("id", booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (!b.overage_invoice_id) return badRequest("No overage invoice for this booking");
  const s = stripe();
  const inv = await s.invoices.retrieve(b.overage_invoice_id);
  if (inv.status === "paid") return badRequest("Already paid");   // prevents double charge

  if (action === "waive") {
    if (inv.status === "open") await s.invoices.voidInvoice(inv.id);
    await db.from("bookings").update({ overage_status: "waived" }).eq("id", b.id);
    await audit({ actor: user.email!, action: "overage.waive", entity: "bookings", entityId: b.id });
    return json({ ok: true, status: "waived" });
  }
  if (!b.stripe_payment_method_id) return badRequest("No saved card on this booking");
  try {
    await s.invoices.pay(inv.id, { payment_method: b.stripe_payment_method_id, off_session: true });
  } catch (err) {
    await audit({ actor: user.email!, action: "overage.charge_failed", entity: "bookings", entityId: b.id, detail: { error: (err as Error).message } });
    return badRequest(`Card charge failed: ${(err as Error).message}`);
  }
  await audit({ actor: user.email!, action: "overage.charge", entity: "bookings", entityId: b.id });
  return json({ ok: true, status: "paid" });   // webhook records the payment row
});
