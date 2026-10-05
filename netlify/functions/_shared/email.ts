import { Resend } from "resend";
import { optionalEnv } from "./env";
import { loadSettings } from "./settings";

// Email is optional: no key => log instead of send (keeps dev frictionless).
function client(): Resend | null {
  const key = optionalEnv("RESEND_API_KEY");
  return key ? new Resend(key) : null;
}

const FROM = optionalEnv("EMAIL_FROM") || "Texas Dumpster Co <bookings@texasdumpsterco.com>";
// The sending domain has no inbox, so customer replies go to the owner's mailbox.
const REPLY_TO = optionalEnv("EMAIL_REPLY_TO") || "texasdumpsterco@gmail.com";

export const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));

// Returns true when the provider accepted the message. Never throws.
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const c = client();
  if (!c) {
    console.log(`[email:skipped] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    // Resend reports API failures (unverified domain, bad sender) in `error`, not by throwing.
    const { error } = await c.emails.send({ from: FROM, to, subject, html, replyTo: REPLY_TO });
    if (error) {
      console.error(`[email] send failed to=${to} subject="${subject}": ${error.name}: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] send failed:", (err as Error).message);
    return false;
  }
}

// Where staff alerts go: the admin Settings "alerts to" value, else the env var.
export async function adminAlertTo(): Promise<string | undefined> {
  const settings = await loadSettings();
  const fromSettings = typeof settings["alert_email"] === "string" ? (settings["alert_email"] as string).trim() : "";
  return fromSettings || optionalEnv("ADMIN_ALERT_EMAIL");
}

export function bookingConfirmationHtml(b: {
  reference: string;
  customer_name: string;
  typeName: string;
  start_date: string;
  end_date: string;
  amount_total_cents: number;
  amount_paid_cents: number;
  payment_method: string;
}): string {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const balance = b.amount_total_cents - b.amount_paid_cents;
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
      <div style="background:#0b0b0c;color:#ffc61a;padding:18px 24px;font-weight:bold;font-size:20px">
        Texas Dumpster Co
      </div>
      <div style="padding:24px;color:#111">
        <h2>Booking confirmed — ${esc(b.reference)}</h2>
        <p>Hi ${esc(b.customer_name)}, thanks for booking with us. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td><strong>Service</strong></td><td>${esc(b.typeName)}</td></tr>
          <tr><td><strong>Dates</strong></td><td>${b.start_date} → ${b.end_date}</td></tr>
          <tr><td><strong>Total</strong></td><td>${dollars(b.amount_total_cents)}</td></tr>
          <tr><td><strong>Paid</strong></td><td>${dollars(b.amount_paid_cents)} (${b.payment_method})</td></tr>
          ${balance > 0 ? `<tr><td><strong>Balance due</strong></td><td>${dollars(balance)}</td></tr>` : ""}
        </table>
        <p>We'll be in touch about delivery. Reply to this email with any questions.</p>
      </div>
    </div>`;
}

export function adminAlertHtml(b: {
  reference: string;
  customer_name: string;
  customer_phone: string;
  typeName: string;
  start_date: string;
  payment_method: string;
  payment_status: string;
}): string {
  return `
    <div style="font-family:Arial,sans-serif">
      <h2>New booking: ${esc(b.reference)}</h2>
      <ul>
        <li><strong>Customer:</strong> ${esc(b.customer_name)} (${esc(b.customer_phone)})</li>
        <li><strong>Service:</strong> ${esc(b.typeName)}</li>
        <li><strong>Delivery:</strong> ${b.start_date}</li>
        <li><strong>Payment:</strong> ${b.payment_method} / ${b.payment_status}</li>
      </ul>
      ${b.payment_status === "cash_pending" ? "<p><strong>⚠ Cash booking — needs approval in the admin.</strong></p>" : ""}
    </div>`;
}
