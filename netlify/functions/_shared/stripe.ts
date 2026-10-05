import Stripe from "stripe";
import { env } from "./env";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  // Use the account's default API version (avoids pinning to an SDK-specific string).
  _stripe = new Stripe(env("STRIPE_SECRET_KEY"), { typescript: true });
  return _stripe;
}

// The PaymentIntent that paid an invoice. Older API versions put it on the invoice;
// newer ones (2025-03-31+) moved it to the invoice_payments list.
export async function invoicePaymentIntentId(inv: Stripe.Invoice): Promise<string | null> {
  const direct = (inv as any).payment_intent;
  if (direct) return typeof direct === "string" ? direct : direct.id ?? null;
  try {
    const res: any = await stripe().rawRequest("GET", `/v1/invoice_payments?invoice=${encodeURIComponent(inv.id!)}&limit=10`);
    const paid = (res?.data ?? []).find((p: any) => p.status === "paid" && p.payment?.payment_intent);
    const pi = paid?.payment?.payment_intent;
    return pi ? (typeof pi === "string" ? pi : pi.id) : null;
  } catch (err) {
    console.error("[stripe] could not resolve invoice payment intent:", (err as Error).message);
    return null;
  }
}
