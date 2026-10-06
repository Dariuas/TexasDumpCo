import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { computeOverageCents } from "./_shared/overage";
import { sendEmail } from "./_shared/email";
import { overageNoticeHtml } from "./_shared/overage-email";
import { audit } from "./_shared/audit";
import { priceLines, taxBpsFor, ensureBaseline, syncTotals, listCharges, createAdjustmentInvoice } from "./_shared/charges";

// Record the scale weight. Any overage becomes a "weight" charge line on the booking
// and is billed on its own invoice (emailed pay link); staff can then charge the
// saved card or waive it from the booking's Charges section.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<{ booking_id?: string; weight_tons?: number; confirm?: boolean }>(req);
  const weight = Number(body.weight_tons);
  if (!body.booking_id || !Number.isFinite(weight) || weight < 0) return badRequest("booking_id and weight_tons required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*, dumpster_types(name)").eq("id", body.booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (b.overage_status === "paid") return badRequest("Overage already paid");
  const { data: t } = await db.from("dumpster_types").select("weight_limit_tons,overage_fee_cents").eq("id", b.type_id).maybeSingle();
  const limit = t?.weight_limit_tons != null ? Number(t.weight_limit_tons) : null;
  const overage = computeOverageCents(weight, limit, t?.overage_fee_cents ?? 0);

  if (!body.confirm) return json({ overage_cents: overage, weight_tons: weight, limit_tons: limit });

  await db.from("bookings").update({ weight_tons: weight, overage_cents: overage, overage_status: overage > 0 ? "due" : "none" }).eq("id", b.id);
  if (overage === 0) {
    await audit({ actor: user.email!, action: "overage.none", entity: "bookings", entityId: b.id, detail: { weight } });
    return json({ overage_cents: 0, invoice_url: null });
  }
  const open = (await listCharges(b.id)).find((r) => r.kind === "weight" && ["draft", "invoiced"].includes(r.status));
  if (open) return badRequest("An overage charge already exists. Remove it in Charges first to re-bill.");
  if (!b.customer_email) return badRequest("No customer email on this booking. Add the overage in Charges and collect it manually.");

  const typeName = (b as any).dumpster_types?.name ?? "Booking";
  const [line] = priceLines([{ kind: "weight", description: `Weight overage: ${weight} tons (limit ${limit} tons)`, quantity: 1, unit_cents: overage }], await taxBpsFor(b));
  await ensureBaseline(b, typeName, user.email!);
  const { data: row, error } = await db.from("booking_charges").insert({ ...line, booking_id: b.id, stage: "adjustment", status: "draft", created_by: user.email }).select().single();
  if (error) throw new Error(error.message);
  await syncTotals(b.id);

  const invoice = await createAdjustmentInvoice(b, [row as any]);
  await db.from("bookings").update({ overage_invoice_id: invoice.id, overage_invoice_url: invoice.hosted_invoice_url }).eq("id", b.id);
  // Stripe does not email invoices in test mode, so we send our own notice with the hosted pay link.
  await sendEmail(b.customer_email, `Weight overage — ${b.reference}`,
    overageNoticeHtml({ reference: b.reference, customer_name: b.customer_name, weight_tons: weight, limit_tons: limit ?? 0, amount_cents: overage, pay_url: invoice.hosted_invoice_url!, has_card: !!b.stripe_payment_method_id }));
  await audit({ actor: user.email!, action: "overage.invoice", entity: "bookings", entityId: b.id, detail: { weight, overage, invoice: invoice.id } });
  return json({ overage_cents: overage, invoice_url: invoice.hosted_invoice_url });
});
