import { withErrors, json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { validatePromo, discountFor, PromoRow } from "./_shared/pricing";

interface Body {
  code?: string;
  subtotal_cents?: number;
  service?: "dumpster" | "junk";
}

// Public: check a promo code against a subtotal. Does not consume the code.
export default withErrors(async (req: Request) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<Body>(req);
  if (!body.code) return badRequest("code is required");
  const subtotal = Number(body.subtotal_cents ?? 0);
  const service = body.service === "junk" ? "junk" : "dumpster";

  const { data, error } = await supabaseAdmin()
    .from("promo_codes")
    .select("*")
    .ilike("code", body.code.trim())
    .maybeSingle();
  if (error) throw new Error(error.message);

  const promo = data as PromoRow | null;
  const check = validatePromo(promo, subtotal, service);
  if (!check.valid || !promo) return json({ valid: false, reason: check.reason });

  return json({
    valid: true,
    code: promo.code,
    discount_cents: discountFor(promo, subtotal),
    kind: promo.kind,
    value: promo.value,
  });
});
