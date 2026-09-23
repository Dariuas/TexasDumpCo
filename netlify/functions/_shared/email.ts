import { Resend } from "resend";
import { optionalEnv } from "./env";

// Email is optional: no key => log instead of send (keeps dev frictionless).
function client(): Resend | null {
  const key = optionalEnv("RESEND_API_KEY");
  return key ? new Resend(key) : null;
}

const FROM = optionalEnv("EMAIL_FROM") || "Texas Dumpster Co <bookings@texasdumpco.com>";

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const c = client();
  if (!c) {
    console.log(`[email:skipped] to=${to} subject="${subject}"`);
    return;
  }
  try {
    await c.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error("[email] send failed:", (err as Error).message);
  }
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
        <h2>Booking confirmed — ${b.reference}</h2>
        <p>Hi ${b.customer_name}, thanks for booking with us. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td><strong>Service</strong></td><td>${b.typeName}</td></tr>
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
      <h2>New booking: ${b.reference}</h2>
      <ul>
        <li><strong>Customer:</strong> ${b.customer_name} (${b.customer_phone})</li>
        <li><strong>Service:</strong> ${b.typeName}</li>
        <li><strong>Delivery:</strong> ${b.start_date}</li>
        <li><strong>Payment:</strong> ${b.payment_method} / ${b.payment_status}</li>
      </ul>
      ${b.payment_status === "cash_pending" ? "<p><strong>⚠ Cash booking — needs approval in the admin.</strong></p>" : ""}
    </div>`;
}
