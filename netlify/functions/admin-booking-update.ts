import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { typeAvailability } from "./_shared/availability";
import { updateCalendarEvent, deleteCalendarEvent, createCalendarEvent } from "./_shared/google-calendar";
import { audit } from "./_shared/audit";

interface Body {
  id?: string;
  action?: "update" | "reschedule" | "cancel" | "set_status";
  // update fields
  status?: string;
  admin_notes?: string;
  flags?: string[];
  unit_id?: string | null;
  time_window?: string;
  delivery_notes?: string;
  // reschedule
  start_date?: string;
  end_date?: string;
}

async function syncCalendar(bookingId: string) {
  const db = supabaseAdmin();
  const { data: b } = await db
    .from("bookings").select("*, dumpster_types(name)").eq("id", bookingId).maybeSingle();
  if (!b) return;
  const typeName = (b as any).dumpster_types?.name ?? "Booking";
  const payload = {
    summary: `${typeName} — ${b.customer_name} (${b.reference})`,
    description: `Phone: ${b.customer_phone}\nEmail: ${b.customer_email}\nRef: ${b.reference}`,
    location: b.delivery_address,
    startDate: b.start_date,
    endDate: b.end_date,
  };
  if (b.google_event_id) {
    await updateCalendarEvent(b.google_event_id, payload);
  } else {
    const eventId = await createCalendarEvent(payload);
    if (eventId) await db.from("bookings").update({ google_event_id: eventId }).eq("id", bookingId);
  }
}

// Modify / reschedule / cancel a booking. Keeps Google Calendar in sync.
export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.id) return badRequest("id required");
  const db = supabaseAdmin();

  const { data: booking } = await db.from("bookings").select("*").eq("id", body.id).maybeSingle();
  if (!booking) return notFound("Booking not found");

  switch (body.action) {
    case "cancel": {
      if (booking.google_event_id) await deleteCalendarEvent(booking.google_event_id);
      await db.from("bookings").update({ status: "canceled", google_event_id: null }).eq("id", body.id);
      await audit({ actor: user.email!, action: "booking.cancel", entity: "bookings", entityId: body.id });
      return json({ ok: true });
    }

    case "reschedule": {
      if (!body.start_date || !body.end_date) return badRequest("start_date and end_date required");
      // Availability excluding this booking is enforced by capacity check.
      const avail = await typeAvailability(booking.type_id, body.start_date, body.end_date);
      // The booking itself may already occupy a slot on its own dates; allow if
      // there is room OR the dates are unchanged.
      const sameWindow = body.start_date === booking.start_date && body.end_date === booking.end_date;
      if (!sameWindow && avail <= 0) return badRequest("No availability for the new dates");
      await db.from("bookings").update({ start_date: body.start_date, end_date: body.end_date }).eq("id", body.id);
      await syncCalendar(body.id!);
      await audit({ actor: user.email!, action: "booking.reschedule", entity: "bookings", entityId: body.id, detail: { start: body.start_date, end: body.end_date } });
      return json({ ok: true });
    }

    case "set_status":
    case "update":
    default: {
      const patch: Record<string, unknown> = {};
      for (const f of ["status", "admin_notes", "flags", "unit_id", "time_window", "delivery_notes"] as const) {
        if (body[f] !== undefined) patch[f] = body[f];
      }
      if (!Object.keys(patch).length) return badRequest("nothing to update");
      const { error } = await db.from("bookings").update(patch).eq("id", body.id);
      if (error) throw new Error(error.message);
      // A status/date-affecting change may need the calendar refreshed.
      if (patch.status && patch.status !== "canceled") await syncCalendar(body.id!);
      await audit({ actor: user.email!, action: "booking.update", entity: "bookings", entityId: body.id, detail: patch });
      return json({ ok: true });
    }
  }
});
