import { esc } from "./email";

export function overageNoticeHtml(b: { reference: string; customer_name: string; weight_tons: number; limit_tons: number; amount_cents: number; pay_url: string; has_card: boolean }): string {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
    <div style="background:#0b0b0c;color:#ffc61a;padding:18px 24px;font-weight:bold;font-size:20px">Texas Dumpster Co</div>
    <div style="padding:24px;color:#111">
      <h2>Weight overage — ${esc(b.reference)}</h2>
      <p>Hi ${esc(b.customer_name)}, your load weighed <strong>${b.weight_tons} tons</strong>; your rental includes ${b.limit_tons} tons.
         The overage is <strong>${dollars(b.amount_cents)}</strong> plus tax, as described in your rental agreement.</p>
      <p><a href="${esc(b.pay_url)}" style="background:#ffc61a;color:#0b0b0c;padding:12px 22px;text-decoration:none;font-weight:bold">Pay now</a></p>
      ${b.has_card ? "<p>If it is not paid, we may charge the card you used at booking.</p>" : ""}
    </div></div>`;
}
