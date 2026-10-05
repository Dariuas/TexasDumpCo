import { stripe } from "./stripe";
import { supabaseAdmin } from "./supabase";

const TAX_CODE = "txcd_20030000"; // general services; owner may change in Stripe dashboard

async function ensureProduct(existingId: string | null, name: string, description: string | null, active: boolean, metadata: Record<string, string>): Promise<string> {
  const s = stripe();
  if (existingId) {
    await s.products.update(existingId, { name, description: description || undefined, active, metadata });
    return existingId;
  }
  const p = await s.products.create({ name, description: description || undefined, active, metadata, tax_code: TAX_CODE });
  return p.id;
}

// Prices are immutable: if the amount changed, archive the old Price and create a new one.
async function ensurePrice(productId: string, existingPriceId: string | null, amountCents: number, nickname: string): Promise<string> {
  const s = stripe();
  if (existingPriceId) {
    const cur = await s.prices.retrieve(existingPriceId);
    if (cur.active && cur.unit_amount === amountCents && cur.product === productId) return existingPriceId;
    await s.prices.update(existingPriceId, { active: false });
  }
  const p = await s.prices.create({ product: productId, currency: "usd", unit_amount: amountCents, tax_behavior: "exclusive", nickname });
  return p.id;
}

export async function syncType(typeId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: t } = await db.from("dumpster_types").select("*").eq("id", typeId).maybeSingle();
  if (!t) throw new Error("Type not found");
  try {
    const productId = await ensureProduct(t.stripe_product_id, t.name, t.description, !!t.active, { source: "dumpster_types", source_id: t.id });
    if (t.pricing_mode === "duration_tiers") {
      const { data: tiers } = await db.from("duration_price_tiers").select("*").eq("type_id", t.id);
      for (const tier of tiers ?? []) {
        const priceId = await ensurePrice(productId, tier.stripe_price_id, tier.price_cents, tier.label || `${tier.days} days`);
        if (priceId !== tier.stripe_price_id) await db.from("duration_price_tiers").update({ stripe_price_id: priceId }).eq("id", tier.id);
      }
    }
    await db.from("dumpster_types").update({ stripe_product_id: productId, stripe_sync_error: null }).eq("id", t.id);
  } catch (err) {
    await db.from("dumpster_types").update({ stripe_sync_error: (err as Error).message.slice(0, 300) }).eq("id", t.id);
    throw err;
  }
}

export async function syncAddon(addonId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: a } = await db.from("addon_items").select("*").eq("id", addonId).maybeSingle();
  if (!a) throw new Error("Add-on not found");
  try {
    const productId = await ensureProduct(a.stripe_product_id, a.name, null, !!a.active, { source: "addon_items", source_id: a.id });
    await db.from("addon_items").update({ stripe_product_id: productId, stripe_sync_error: null }).eq("id", a.id);
  } catch (err) {
    await db.from("addon_items").update({ stripe_sync_error: (err as Error).message.slice(0, 300) }).eq("id", a.id);
    throw err;
  }
}

// Fixed products with no row of their own: deposit, weight overage, distance-fee zones.
export async function ensureFixedProduct(key: string, name: string): Promise<string> {
  const db = supabaseAdmin();
  const { data: row } = await db.from("stripe_catalog_items").select("*").eq("key", key).maybeSingle();
  const productId = await ensureProduct(row?.stripe_product_id ?? null, name, null, true, { source: "fixed", key });
  if (!row?.stripe_product_id) await db.from("stripe_catalog_items").upsert({ key, stripe_product_id: productId });
  return productId;
}

export async function productIdForType(typeId: string): Promise<string> {
  const { data: t } = await supabaseAdmin().from("dumpster_types").select("stripe_product_id").eq("id", typeId).maybeSingle();
  if (t?.stripe_product_id) return t.stripe_product_id;
  await syncType(typeId);
  const { data: again } = await supabaseAdmin().from("dumpster_types").select("stripe_product_id").eq("id", typeId).maybeSingle();
  return again!.stripe_product_id as string;
}

export async function productIdForAddon(addonId: string): Promise<string> {
  const { data: a } = await supabaseAdmin().from("addon_items").select("stripe_product_id").eq("id", addonId).maybeSingle();
  if (a?.stripe_product_id) return a.stripe_product_id;
  await syncAddon(addonId);
  const { data: again } = await supabaseAdmin().from("addon_items").select("stripe_product_id").eq("id", addonId).maybeSingle();
  return again!.stripe_product_id as string;
}

export async function syncAll(): Promise<{ ok: number; failed: { id: string; error: string }[] }> {
  const db = supabaseAdmin();
  const failed: { id: string; error: string }[] = [];
  let ok = 0;
  const [{ data: types }, { data: addons }] = await Promise.all([
    db.from("dumpster_types").select("id"), db.from("addon_items").select("id"),
  ]);
  for (const t of types ?? []) { try { await syncType(t.id); ok++; } catch (e) { failed.push({ id: t.id, error: (e as Error).message }); } }
  for (const a of addons ?? []) { try { await syncAddon(a.id); ok++; } catch (e) { failed.push({ id: a.id, error: (e as Error).message }); } }
  for (const [key, name] of [["deposit", "Booking deposit"], ["overage", "Weight overage"], ["distance_fee", "Distance fee"]] as const) {
    try { await ensureFixedProduct(key, name); ok++; } catch (e) { failed.push({ id: key, error: (e as Error).message }); }
  }
  return { ok, failed };
}
