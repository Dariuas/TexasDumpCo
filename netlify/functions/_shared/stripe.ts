import Stripe from "stripe";
import { env } from "./env";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  // Use the account's default API version (avoids pinning to an SDK-specific string).
  _stripe = new Stripe(env("STRIPE_SECRET_KEY"), { typescript: true });
  return _stripe;
}
