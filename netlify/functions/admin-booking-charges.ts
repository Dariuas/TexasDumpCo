import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { siteUrl } from "./_shared/env";
import { assignUnitAndConfirm } from "./_shared/confirm";
import { syncBookingEvent } from "./_shared/booking-calendar";
import { sendEmail, esc } from "./_shared/email";
import { audit } from "./_shared/audit";
import {
  ChargeLine, ChargeRow, priceLines, taxBpsFor, listCharges, syncTotals, ensureBaseline,
  createPayLink, createAdjustmentInvoice, chargesTableHtml,
} from "./_shared/charges";

interface Body {
  booking_id?: string;
  action?: "save_initial" | "pay_link" | "add" | "remove" | "bill";
  lines?: ChargeLine[];        // save_initial: the full quote; add: one or more adjustment lines
  charge_id?: string;          // remove
  method?: "charge" | "link";  // bill: charge the saved card or email a pay link
}

const header = `<div style="background:#0b0b0c;color:#ffc61a;padding:18px 24px;font-weight:bold;font-size:20px">Texas Dumpster Co</div>`;
const button = (url: string, label: string) =>
  `<p><a href="${esc(url)}" style="background:#ffc61a;color:#0b0b0c;padding:12px 22px;text-decoration:none;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;

// Itemized charges on a booking:
//  - save_initial: invoice builder. Prices a quote/contractor request line by line,
//    confirms it (reserves a container) and emails the customer the itemized total.
//  - pay_link:     Stripe Checkout for the open initial lines (card saved for later).
//  - add:          adjustment lines after the job (weight, mileage, extra days, fees).
//  - remove:       void a draft line, or void an unpaid invoice and its lines.
//  - bill:         put open adjustment lines on one invoice and charge the saved card
//                  or email the pay link.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.booking_id) return badRequest("booking_id required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*, dumpster_types(name)").eq("id", body.booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (b.status === "canceled") return badRequest("Booking is canceled");
  const typeName = (b as any).dumpster_types?.name ?? "Booking";
  const taxBps = await taxBpsFor(b);

  if (body.action === "save_initial") {
    const existing = (await listCharges(b.id)).filter((r) => r.stage === "initial");
    const linked = (r: ChargeRow) => r.status === "invoiced" && !!r.stripe_invoice_id?.startsWith("cs_");
    if (existing.some((r) => ["paid", "external"].includes(r.status) || (r.status === "invoiced" && !linked(r)))) {
      return badRequest("This booking's first invoice is already paid. Add adjustments instead.");
    }
    // Editing after a pay link went out: cancel that link so the old amount can't be paid.
    for (const sid of new Set(existing.filter(linked).map((r) => r.stripe_invoice_id!))) {
      const old = await stripe().checkout.sessions.retrieve(sid);
      if (old.payment_status === "paid") return badRequest("The pay link was already paid. Use Check payment in Stripe.");
      if (old.status === "open") await stripe().checkout.sessions.expire(sid);
    }
    const priced = priceLines(body.lines ?? [], taxBps);
    if (!priced.length) return badRequest("Add at least one line");
    if (priced.reduce((t, l) => t + l.amount_cents, 0) <= 0) return badRequest("The total must be more than $0");

    const isRequest = b.status === "pending" && (b.flags ?? []).includes("quote_requested");
    if (isRequest) {
      // Same capacity guard as a paid booking.
      const confirmed = await assignUnitAndConfirm(b.id, { payment_status: "unpaid", amount_paid_cents: b.amount_paid_cents ?? 0 });
      if (!confirmed) return badRequest("No container free for those dates. Reschedule first.");
    }
    await db.from("booking_charges").delete().eq("booking_id", b.id).eq("stage", "initial").in("status", ["draft", "invoiced"]);
    const { error } = await db.from("booking_charges").insert(priced.map((l) => ({
      ...l, booking_id: b.id, stage: "initial", status: "draft", created_by: user.email,
    })));
    if (error) throw new Error(error.message);
    const flags = (b.flags ?? []).filter((f: string) => f !== "quote_requested" && f !== "contractor_request");
    await db.from("bookings").update({ flags, addon_cents: 0, deposit_cents: 0, payment_method: "card" }).eq("id", b.id);
    await syncTotals(b.id);
    if (isRequest) {
      await syncBookingEvent(b.id); // the PENDING request becomes the confirmed booking
      await sendEmail(b.customer_email, `Booking confirmed — ${b.reference}`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${header}<div style="padding:24px;color:#111">
           <h2>Your booking is confirmed — ${esc(b.reference)}</h2>
           <p>Hi ${esc(b.customer_name)}, here is your price for ${esc(typeName)} (${esc(b.start_date)} to ${esc(b.end_date)}):</p>
           ${chargesTableHtml(priced)}
           <p>We'll send a secure payment link separately.</p></div></div>`);
    }
    await audit({ actor: user.email!, action: "charges.save_initial", entity: "bookings", entityId: b.id, detail: { lines: priced.length, confirmed: isRequest } });
    return json({ ok: true, confirmed: isRequest });
  }

  if (body.action === "pay_link") {
    const rows = (await listCharges(b.id)).filter((r) => r.stage === "initial" && (r.status === "draft" || (r.status === "invoiced" && r.stripe_invoice_id?.startsWith("cs_"))));
    if (!rows.length) return badRequest("No unpaid invoice lines. Build the invoice first.");
    // A new link replaces any earlier unpaid one, so only one can ever be paid.
    for (const sid of new Set(rows.map((r) => r.stripe_invoice_id).filter((x): x is string => !!x))) {
      try {
        const old = await stripe().checkout.sessions.retrieve(sid);
        if (old.payment_status === "paid") return badRequest("The earlier pay link was already paid. Use Check payment in Stripe.");
        if (old.status === "open") await stripe().checkout.sessions.expire(sid);
      } catch (err) { console.error("[charges] could not expire old link:", (err as Error).message); }
    }
    const session = await createPayLink(b, rows, `${siteUrl()}/book/confirm.html?ref=${b.reference}&paid=1`, `${siteUrl()}/`);
    await db.from("booking_charges").update({ status: "invoiced", stripe_invoice_id: session.id }).in("id", rows.map((r) => r.id));
    await db.from("bookings").update({ stripe_checkout_session_id: session.id }).eq("id", b.id);
    const sent = await sendEmail(b.customer_email, `Payment link — ${b.reference}`,
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${header}<div style="padding:24px;color:#111">
         <h2>Payment for booking ${esc(b.reference)}</h2>
         <p>Hi ${esc(b.customer_name)}, here is the total for ${esc(typeName)} (${esc(b.start_date)} to ${esc(b.end_date)}):</p>
         ${chargesTableHtml(rows)}
         ${button(session.url!, "Pay securely")}
         <p style="color:#555;font-size:13px">The link works for 23 hours; ask us for a new one if it expires. Your card is saved securely with Stripe for any charges described in your rental agreement (for example a weight overage), and we always email the amount first.</p>
       </div></div>`);
    await audit({ actor: user.email!, action: "charges.pay_link", entity: "bookings", entityId: b.id, detail: { session: session.id } });
    return json({ ok: true, url: session.url, emailed: sent });
  }

  if (body.action === "add") {
    const priced = priceLines(body.lines ?? [], taxBps);
    if (!priced.length) return badRequest("Add at least one line");
    if (priced.some((l) => l.amount_cents <= 0)) return badRequest("Added charges must be more than $0. Use Refund to give money back.");
    await ensureBaseline(b, typeName, user.email!);
    const { error } = await db.from("booking_charges").insert(priced.map((l) => ({
      ...l, booking_id: b.id, stage: "adjustment", status: "draft", created_by: user.email,
    })));
    if (error) throw new Error(error.message);
    await syncTotals(b.id);
    await audit({ actor: user.email!, action: "charges.add", entity: "bookings", entityId: b.id, detail: priced.map((l) => ({ kind: l.kind, amount: l.amount_cents })) });
    return json({ ok: true });
  }

  if (body.action === "remove") {
    if (!body.charge_id) return badRequest("charge_id required");
    const { data: row } = await db.from("booking_charges").select("*").eq("id", body.charge_id).eq("booking_id", b.id).maybeSingle();
    if (!row) return notFound("Charge not found");
    const r = row as ChargeRow;
    if (r.status === "paid" || r.status === "external") return badRequest("Paid lines can't be removed. Use Refund instead.");
    if (r.status === "invoiced" && r.stripe_invoice_id) {
      // Pull the whole unpaid invoice/link; its other lines go back to draft to re-bill.
      if (r.stripe_invoice_id.startsWith("in_")) {
        const inv = await stripe().invoices.retrieve(r.stripe_invoice_id);
        if (inv.status === "paid") return badRequest("That invoice was already paid.");
        if (inv.status === "open") await stripe().invoices.voidInvoice(inv.id);
      } else {
        const s = await stripe().checkout.sessions.retrieve(r.stripe_invoice_id);
        if (s.payment_status === "paid") return badRequest("That pay link was already paid. Use Check payment in Stripe.");
        if (s.status === "open") await stripe().checkout.sessions.expire(s.id);
      }
      await db.from("booking_charges").update({ status: "draft", stripe_invoice_id: null }).eq("stripe_invoice_id", r.stripe_invoice_id).neq("id", r.id);
    }
    await db.from("booking_charges").update({ status: "void" }).eq("id", r.id);
    if (r.kind === "weight") await db.from("bookings").update({ overage_status: "waived" }).eq("id", b.id);
    await syncTotals(b.id);
    await audit({ actor: user.email!, action: "charges.remove", entity: "bookings", entityId: b.id, detail: { charge: r.id, amount: r.amount_cents } });
    return json({ ok: true });
  }

  if (body.action === "bill") {
    const rows = (await listCharges(b.id)).filter((r) => r.stage === "adjustment" && r.status === "draft");
    if (!rows.length) return badRequest("No new charges to bill");
    if (body.method === "charge" && !b.stripe_payment_method_id) return badRequest("No saved card on this booking. Email a pay link instead.");
    const invoice = await createAdjustmentInvoice(b, rows);
    if (rows.some((r) => r.kind === "weight")) {
      await db.from("bookings").update({ overage_invoice_id: invoice.id, overage_invoice_url: invoice.hosted_invoice_url, overage_status: "due" }).eq("id", b.id);
    }
    if (body.method === "charge") {
      try {
        await stripe().invoices.pay(invoice.id, { payment_method: b.stripe_payment_method_id, off_session: true });
      } catch (err) {
        await audit({ actor: user.email!, action: "charges.charge_failed", entity: "bookings", entityId: b.id, detail: { error: (err as Error).message } });
        return badRequest(`Card charge failed: ${(err as Error).message}. The invoice is still open — email the pay link instead.`);
      }
      await sendEmail(b.customer_email, `Receipt for additional charges — ${b.reference}`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${header}<div style="padding:24px;color:#111">
           <h2>Additional charges — ${esc(b.reference)}</h2>
           <p>Hi ${esc(b.customer_name)}, as described in your rental agreement, the card on file was charged for:</p>
           ${chargesTableHtml(rows)}
           ${invoice.hosted_invoice_url ? `<p><a href="${esc(invoice.hosted_invoice_url)}">View your invoice</a></p>` : ""}
           <p>Questions? Just reply to this email.</p></div></div>`);
      await audit({ actor: user.email!, action: "charges.charge", entity: "bookings", entityId: b.id, detail: { invoice: invoice.id } });
      return json({ ok: true, status: "paid" }); // the invoice.paid webhook ledgers the payment
    }
    const sent = await sendEmail(b.customer_email, `Additional charges — ${b.reference}`,
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${header}<div style="padding:24px;color:#111">
         <h2>Additional charges — ${esc(b.reference)}</h2>
         <p>Hi ${esc(b.customer_name)}, here are the additional charges for your ${esc(typeName)} (${esc(b.start_date)} to ${esc(b.end_date)}):</p>
         ${chargesTableHtml(rows)}
         ${button(invoice.hosted_invoice_url ?? "", "Pay now")}
       </div></div>`);
    await audit({ actor: user.email!, action: "charges.link", entity: "bookings", entityId: b.id, detail: { invoice: invoice.id } });
    return json({ ok: true, emailed: sent, url: invoice.hosted_invoice_url });
  }

  return badRequest("Unknown action");
});
