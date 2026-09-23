import { google } from "googleapis";
import { optionalEnv } from "./env";

// Google Calendar is optional: if credentials aren't configured, calendar
// sync is skipped silently so bookings still work in dev.
function calendarClient() {
  const raw = optionalEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const calendarId = optionalEnv("GOOGLE_CALENDAR_ID");
  if (!raw || !calendarId) return null;

  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  });
  return { api: google.calendar({ version: "v3", auth }), calendarId };
}

export interface CalEventInput {
  summary: string;
  description: string;
  location?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (inclusive last rental day)
}

// All-day events spanning the rental. Google end date is exclusive, so +1 day.
function toBody(input: CalEventInput) {
  const end = new Date(input.endDate + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { date: input.startDate },
    end: { date: end.toISOString().slice(0, 10) },
  };
}

export async function createCalendarEvent(input: CalEventInput): Promise<string | null> {
  const client = calendarClient();
  if (!client) return null;
  const res = await client.api.events.insert({
    calendarId: client.calendarId,
    requestBody: toBody(input),
  });
  return res.data.id ?? null;
}

export async function updateCalendarEvent(
  eventId: string,
  input: CalEventInput,
): Promise<void> {
  const client = calendarClient();
  if (!client) return;
  await client.api.events.update({
    calendarId: client.calendarId,
    eventId,
    requestBody: toBody(input),
  });
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const client = calendarClient();
  if (!client) return;
  try {
    await client.api.events.delete({ calendarId: client.calendarId, eventId });
  } catch (err) {
    // A missing/already-deleted event shouldn't fail the cancellation.
    console.warn("[calendar] delete skipped:", (err as Error).message);
  }
}
