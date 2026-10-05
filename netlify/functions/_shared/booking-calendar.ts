import { supabaseAdmin } from "./supabase";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, calendarConfigured } from "./google-calendar";

// Google Calendar color ids: 5 = yellow (banana), 10 = green (basil).
const PENDING_COLOR = "5";
const CONFIRMED_COLOR = "10";

const dollars = (c: number) => `$${((c ?? 0) / 100).toFixed(2)}`;

// Which bookings belong on the owner's calendar, and how:
//  - confirmed and later (scheduled, delivered, ...)      -> normal event (green)
//  - pending requests waiting on staff: quote requests,
//    cash awaiting approval, paid-but-no-capacity          -> "⏳ PENDING" event (yellow)
//  - pending card checkouts still on their 30-min hold     -> nothing (not a real booking yet)
//  - canceled                                              -> event removed
function classify(b: any): "confirmed" | "pending" | "none" {
  if (b.status === "canceled") return "none";
  if (b.status !== "pending") return "confirmed";
  const flags: string[] = b.flags ?? [];
  if (flags.includes("quote_requested") || flags.includes("paid_no_capacity") || b.payment_status === "cash_pending") return "pending";
  return "none";
}

// Create, update or remove the booking's Google Calendar event to match its current
// state. Never throws: a Google failure is logged and flagged (calendar_failed) so it
// can't block a payment, an approval or an email. Returns false on failure.
export async function syncBookingEvent(bookingId: string): Promise<boolean> {
  if (!calendarConfigured()) return true;
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*, dumpster_types(name)").eq("id", bookingId).maybeSingle();
  if (!b) return true;
  const kind = classify(b);

  try {
    if (kind === "none") {
      if (b.google_event_id) {
        await deleteCalendarEvent(b.google_event_id);
        await db.from("bookings").update({ google_event_id: null }).eq("id", b.id);
      }
      return true;
    }

    const typeName = (b as any).dumpster_types?.name ?? "Booking";
    const flags: string[] = b.flags ?? [];
    const why = flags.includes("quote_requested") ? "quote request — set price to confirm"
      : b.payment_status === "cash_pending" ? "cash booking — approve to confirm"
      : flags.includes("paid_no_capacity") ? "PAID but no container free — reschedule or refund"
      : "";
    const tag = b.payment_method === "cash" ? " [CASH]" : "";
    const summary = kind === "pending"
      ? `⏳ PENDING — ${typeName} — ${b.customer_name} (${b.reference})`
      : `${typeName} — ${b.customer_name} (${b.reference})${tag}`;
    const description = [
      kind === "pending" ? `NOT CONFIRMED: ${why}` : `Status: ${b.status}`,
      `Customer: ${b.customer_name}`,
      `Phone: ${b.customer_phone}`,
      b.customer_email ? `Email: ${b.customer_email}` : "",
      `Drop-off: ${b.start_date}${b.time_window ? ` (${b.time_window})` : ""}`,
      `Pickup: ${b.end_date}`,
      `Payment: ${b.payment_method} · ${String(b.payment_status).replace(/_/g, " ")} · paid ${dollars(b.amount_paid_cents)} of ${dollars(b.amount_total_cents)}`,
      b.delivery_notes ? `Delivery notes: ${b.delivery_notes}` : "",
      b.notes ? `Job notes: ${b.notes}` : "",
      `Ref: ${b.reference}`,
    ].filter(Boolean).join("\n");
    const input = {
      summary, description, location: b.delivery_address,
      startDate: b.start_date, endDate: b.end_date,
      colorId: kind === "pending" ? PENDING_COLOR : CONFIRMED_COLOR,
    };

    let eventId: string | null = b.google_event_id;
    if (eventId) {
      try {
        await updateCalendarEvent(eventId, input);
      } catch (err: any) {
        // Someone deleted the event in Google Calendar: put it back.
        if (err?.code === 404 || err?.code === 410) eventId = null;
        else throw err;
      }
    }
    if (!eventId) {
      eventId = await createCalendarEvent(input);
      if (eventId) await db.from("bookings").update({ google_event_id: eventId }).eq("id", b.id);
    }
    if (flags.includes("calendar_failed")) {
      await db.from("bookings").update({ flags: flags.filter((f) => f !== "calendar_failed") }).eq("id", b.id);
    }
    return true;
  } catch (err) {
    console.error(`[calendar] sync failed for ${b.reference}:`, (err as Error).message);
    if (!(b.flags ?? []).includes("calendar_failed")) {
      await db.from("bookings").update({ flags: [...(b.flags ?? []), "calendar_failed"] }).eq("id", b.id);
    }
    return false;
  }
}
