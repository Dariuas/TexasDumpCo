import { stripe } from "./stripe";
import { supabaseAdmin } from "./supabase";

const TAX_CODE = "txcd_20030000"; // general services; owner may change in Stripe dashboard

// Cached Product/Price/Tax Rate ids belong to one Stripe mode: test-mode ids don't exist
// for live keys. Remember which mode built the cache (settings.stripe_catalog_mode) and,
// when the secret key's mode differs, drop every cached id so it is re-created on demand.
const MODE_KEY = "stripe_catalog_mode";
let _modeChecked: Promise<void> | null = null;

function keyMode(): "live" | "test" {
  return /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY ?? "") ? "live" : "test";
}

async function cachedIdsMissing(): Promise<boolean> {
  // No recorded mode yet (first run after this code shipped): probe one cached product.
  const db = supabaseAdmin();
  const { data: t } = await db.from("dumpster_types").select("stripe_product_id").not("stripe_product_id", "is", null).limit(1).maybeSingle();
  const { data: f } = t ? { data: null } : await db.from("stripe_catalog_items").select("stripe_product_id").not("stripe_product_id", "is", null).limit(1).maybeSingle();
  const id = t?.stripe_product_id ?? f?.stripe_product_id;
  if (!id) return false;
  try { await stripe().products.retrieve(id); return false; }
  catch (err) { if ((err as any)?.code === "resource_missing") return true; throw err; }
}

async function clearCachedIds(): Promise<void> {
  const db = supabaseAdmin();
  const results = await Promise.all([
    db.from("dumpster_types").update({ stripe_product_id: null, stripe_sync_error: null }).not("stripe_product_id", "is", null),
    db.from("duration_price_tiers").update({ stripe_price_id: null }).not("stripe_price_id", "is", null),
    db.from("addon_items").update({ stripe_product_id: null, stripe_sync_error: null }).not("stripe_product_id", "is", null),
    db.from("stripe_catalog_items").delete().neq("key", ""),
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Could not reset Stripe catalog ids: ${failed.error!.message}`);
}

async function checkMode(): Promise<void> {
  const db = supabaseAdmin();
  const mode = keyMode();
  const { data: row } = await db.from("settings").select("value").eq("key", MODE_KEY).maybeSingle();
  const stale = row ? row.value !== mode : await cachedIdsMissing();
  if (stale) {
    console.warn(`[stripe-catalog] Stripe mode is now ${mode}; clearing cached catalog ids`);
    await clearCachedIds();
  }
  if (!row || row.value !== mode) {
    const { error } = await db.from("settings").upsert({ key: MODE_KEY, value: mode });
    if (error) throw new Error(error.message);
  }
}

export function ensureCatalogMode(): Promise<void> {
  if (!_modeChecked) _modeChecked = checkMode().catch((err) => { _modeChecked = null; throw err; });
  return _modeChecked;
}

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
  await ensureCatalogMode();
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
  await ensureCatalogMode();
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
  await ensureCatalogMode();
  const db = supabaseAdmin();
  const { data: row } = await db.from("stripe_catalog_items").select("*").eq("key", key).maybeSingle();
  const productId = await ensureProduct(row?.stripe_product_id ?? null, name, null, true, { source: "fixed", key });
  if (!row?.stripe_product_id) await db.from("stripe_catalog_items").upsert({ key, stripe_product_id: productId });
  return productId;
}

export async function productIdForType(typeId: string): Promise<string> {
  await ensureCatalogMode();
  const { data: t } = await supabaseAdmin().from("dumpster_types").select("stripe_product_id").eq("id", typeId).maybeSingle();
  if (t?.stripe_product_id) return t.stripe_product_id;
  await syncType(typeId);
  const { data: again } = await supabaseAdmin().from("dumpster_types").select("stripe_product_id").eq("id", typeId).maybeSingle();
  return again!.stripe_product_id as string;
}

export async function productIdForAddon(addonId: string): Promise<string> {
  await ensureCatalogMode();
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

// Texas sales tax as a Stripe Tax Rate, from the admin `tax_rate_bps` setting (825 = 8.25%).
// Attached to every line so Checkout, receipts and invoices show "Subtotal" and a
// separate "Sales Tax" line that match the estimate on the booking page exactly.
// Tax Rates are immutable, so a new rate is created (and cached) whenever the setting changes.
export async function ensureTaxRate(bps: number): Promise<string | null> {
  if (!(bps > 0)) return null;
  await ensureCatalogMode();
  const db = supabaseAdmin();
  const key = `sales_tax_${bps}`;
  const { data: row } = await db.from("stripe_catalog_items").select("stripe_price_id").eq("key", key).maybeSingle();
  if (row?.stripe_price_id) return row.stripe_price_id;
  const rate = await stripe().taxRates.create({
    display_name: "Sales Tax",
    description: `Texas sales tax ${bps / 100}%`,
    percentage: bps / 100,
    inclusive: false,
    country: "US",
    state: "TX",
    jurisdiction: "TX",
    tax_type: "sales_tax",
    metadata: { source: "settings.tax_rate_bps", bps: String(bps) },
  });
  await db.from("stripe_catalog_items").upsert({ key, stripe_price_id: rate.id, amount_cents: bps });
  return rate.id;
}
