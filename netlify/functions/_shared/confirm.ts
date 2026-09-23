import { supabaseAdmin } from "./supabase";

interface ConfirmPatch {
  payment_status: "paid" | "deposit_paid" | "unpaid" | "cash_pending";
  amount_paid_cents: number;
  stripe_payment_intent_id?: string | null;
  stripe_customer_id?: string | null;
}

// Confirm a pending booking: verify capacity still exists, assign a free
// physical unit, mark it confirmed, and clear the inventory hold. Used by
// both the Stripe webhook (card) and cash approval.
export async function assignUnitAndConfirm(bookingId: string, patch: ConfirmPatch): Promise<void> {
  const db = supabaseAdmin();

  const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!booking) throw new Error("Booking not found");

  // Capacity guard against the last-unit race.
  const { data: hasRoom, error: capErr } = await db.rpc("try_reserve_capacity", { p_booking: bookingId });
  if (capErr) throw new Error(capErr.message);

  // Pick a concrete free unit of this type (best effort — availability may be
  // driven by units OR by a per-day cap, so a null unit is acceptable).
  let unitId: string | null = null;
  if (hasRoom) {
    const { data: units } = await db
      .from("inventory_units").select("id")
      .eq("type_id", booking.type_id)
      .in("status", ["available", "in_service"]);
    const candidateIds = (units ?? []).map((u) => u.id);
    if (candidateIds.length) {
      const { data: busy } = await db
        .from("bookings").select("unit_id")
        .neq("status", "canceled").neq("id", bookingId)
        .not("unit_id", "is", null)
        .lte("start_date", booking.end_date).gte("end_date", booking.start_date);
      const busyIds = new Set((busy ?? []).map((b) => b.unit_id));
      unitId = candidateIds.find((id) => !busyIds.has(id)) ?? null;
    }
  }

  await db.from("bookings").update({
    status: "confirmed",
    unit_id: unitId,
    payment_status: patch.payment_status,
    amount_paid_cents: patch.amount_paid_cents,
    stripe_payment_intent_id: patch.stripe_payment_intent_id ?? booking.stripe_payment_intent_id,
    stripe_customer_id: patch.stripe_customer_id ?? booking.stripe_customer_id,
    hold_expires_at: null,
  }).eq("id", bookingId);
}
