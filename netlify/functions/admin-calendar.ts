import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { createCalendarEvent, deleteCalendarEvent, calendarConfigured } from "./_shared/google-calendar";
import { syncBookingEvent } from "./_shared/booking-calendar";

// Google Calendar tools for Settings.
//  action "test":     write and delete a throwaway event, report Google's exact error if any.
//  action "backfill": put every current/upcoming booking on the calendar (confirmed or PENDING).
export default adminHandler("admin", async (req) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { action } = await readJson<{ action?: string }>(req);
  if (!calendarConfigured()) {
    return json({ ok: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID are not both set in Netlify." });
  }

  if (action === "test") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    try {
      const id = await createCalendarEvent({ summary: "Texas Dumpster Co — calendar test (auto-deleted)", description: "Created by Admin → Settings → Test Google Calendar.", startDate: today, endDate: today });
      if (!id) return json({ ok: false, error: "Google did not return an event id." });
      await deleteCalendarEvent(id);
      return json({ ok: true, message: "Google Calendar is connected: a test event was created and removed." });
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status;
      const msg = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      const hint = status === 404 ? " The calendar was not found: share it with the service account's client_email (Make changes to events) and check GOOGLE_CALENDAR_ID."
        : status === 403 ? " The service account can see the calendar but cannot write: give it 'Make changes to events'."
        : /invalid_grant|private key|DECODER/i.test(msg) ? " The service-account JSON/key is invalid; paste the full JSON key file again."
        : "";
      return json({ ok: false, error: `${status ?? ""} ${msg}.${hint}`.trim() });
    }
  }

  if (action === "backfill") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const { data: rows, error } = await supabaseAdmin().from("bookings").select("id").gte("end_date", today).neq("status", "canceled").limit(500);
    if (error) throw new Error(error.message);
    let ok = 0, failed = 0;
    for (const r of rows ?? []) (await syncBookingEvent(r.id)) ? ok++ : failed++;
    return json({ ok: failed === 0, synced: ok, failed });
  }

  return badRequest("action must be test or backfill");
});
