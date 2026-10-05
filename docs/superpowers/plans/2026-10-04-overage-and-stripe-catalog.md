# Overage billing, Stripe catalog sync and Stripe Tax — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge the base price at booking and keep the card on file; bill weight overage later via a Stripe Invoice (customer Pay link or staff "Charge saved card"); mirror every priced item into Stripe's Product Catalog; let Stripe Tax calculate tax.

**Architecture:** A shared `_shared/stripe-catalog.ts` syncs `dumpster_types`, `duration_price_tiers`, `addon_items` and fixed fee items to Stripe Products/Prices and stores the IDs. Checkout line items reference the catalog **Product** (`price_data.product`) with `automatic_tax` on, and save the card off-session. Overage is a Stripe Invoice created from an admin-entered scale weight; the webhook reconciles `invoice.paid` / `invoice.payment_failed`.

**Tech Stack:** Netlify Functions (TypeScript), Supabase Postgres, Stripe SDK `^17.3.1` (test mode only), Resend email, vanilla JS admin (`admin/admin.js`). Pure logic is tested with Node's built-in runner: `node --test` (Node 24 strips TypeScript types natively).

**Spec:** `docs/superpowers/specs/2026-10-04-overage-and-stripe-catalog-design.md`

## Global Constraints

- Stripe stays in **TEST mode**. Never read, write or reference live keys.
- Do not change any customer-facing price. Roll-off: 1 day $339, 3 days $369, 7 days $419, 14 days $539, 28 days $739.
- Overage is **manual only**: nothing is ever charged without a staff click or the customer paying the invoice.
- Keep changes small, one commit per task, clear messages. No refactors of unrelated code.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01BiGmkmX7S1d812ZAHnweot`.
- Admin endpoints use `adminHandler("admin"|"staff", ...)` from `netlify/functions/_shared/admin.ts`; money is integer cents; DB access via `supabaseAdmin()`.
- Existing deployed behavior for quote-only (cleanout etc.) and cash paths must not change.

## Review Focus

- Weight at or below the limit, exactly at the limit, or blank/negative → overage is $0 and no invoice is created.
- Rounding: 0.37 tons over at $90/ton → $33.30 (round half up to the cent), never fractional cents.
- Catalog sync run twice, or a Stripe failure midway → no duplicate Products; item shows "sync failed" and is retryable; saving the item still succeeds.
- Customer paid via Pay link, then staff clicks "Charge saved card" → must not double charge (invoice already `paid`).
- Booking paid by cash/deposit-less/old booking with no saved card → "Charge saved card" disabled with reason; Pay-link path still works.
- Stripe Tax result differs from the site's estimate → booking stores Stripe's `amount_total`/`tax`, not our estimate.
- Declined saved card (`4000 0000 0000 0341`) → invoice stays open, status stays `due`, staff see the reason.
- Webhook retried / events arrive twice → one `payments` row per invoice.

---

## File Structure

- Create `supabase/migrations/20261004000001_stripe_catalog_overage.sql` — new columns, enum value, settings.
- Create `netlify/functions/_shared/overage.ts` — pure overage math (no imports).
- Create `netlify/functions/_shared/overage.test.ts` — `node --test` unit tests.
- Create `netlify/functions/_shared/stripe-catalog.ts` — Product/Price sync.
- Modify `netlify/functions/admin-inventory.ts` — call sync after type/tier/addon writes.
- Create `netlify/functions/admin-stripe-sync.ts` — "Sync all" + per-item retry.
- Modify `netlify/functions/create-booking.ts` — catalog-linked lines, automatic tax, save card.
- Modify `netlify/functions/stripe-webhook.ts` — store payment method, Stripe tax/total; invoice events.
- Create `netlify/functions/admin-record-weight.ts` — compute overage, create invoice, email customer.
- Create `netlify/functions/admin-charge-overage.ts` — pay invoice with saved card; waive.
- Modify `netlify/functions/_shared/email.ts` — overage notice + receipt templates.
- Modify `admin/admin.js` — Stripe sync UI in Inventory tab; weight/overage UI in booking drawer.
- Modify `book/booking.js`, `book/index.html`, `supabase/seed.sql` — estimate label, card-on-file consent line.
- Modify `docs/DEPLOY.md` — webhook events to enable, Stripe Tax prerequisite.

---

### Task 1: Migration

**Files:** Create `supabase/migrations/20261004000001_stripe_catalog_overage.sql`

**Interfaces — Produces:** columns `dumpster_types.stripe_product_id`, `dumpster_types.stripe_sync_error`, `duration_price_tiers.stripe_price_id`, `addon_items.stripe_product_id`, `addon_items.stripe_sync_error`; `bookings.stripe_payment_method_id`, `weight_tons`, `overage_cents`, `overage_status`, `overage_invoice_id`, `overage_invoice_url`; `payment_kind` value `overage`; table `stripe_catalog_items(key text primary key, stripe_product_id text, stripe_price_id text, amount_cents int)` for fixed products (`deposit`, `overage`, `distance_zone1`…).

- [ ] **Step 1: Write the migration**

```sql
-- Stripe catalog + weight overage billing
alter table dumpster_types      add column if not exists stripe_product_id text,
                                add column if not exists stripe_sync_error text;
alter table duration_price_tiers add column if not exists stripe_price_id text;
alter table addon_items         add column if not exists stripe_product_id text,
                                add column if not exists stripe_sync_error text;

create table if not exists stripe_catalog_items (
  key text primary key,
  stripe_product_id text,
  stripe_price_id text,
  amount_cents int,
  updated_at timestamptz not null default now()
);
alter table stripe_catalog_items enable row level security;  -- service role only

alter table bookings
  add column if not exists stripe_payment_method_id text,
  add column if not exists weight_tons numeric(6,2),
  add column if not exists overage_cents int not null default 0,
  add column if not exists overage_status text not null default 'none'
    check (overage_status in ('none','due','paid','waived')),
  add column if not exists overage_invoice_id text,
  add column if not exists overage_invoice_url text;

alter type payment_kind add value if not exists 'overage';
```

- [ ] **Step 2: Apply to the project** (test/dev DB first): `npx supabase db push`. Expected: migration applied, no errors.
- [ ] **Step 3: Verify** with `select column_name from information_schema.columns where table_name='bookings' and column_name like 'overage%';` → 3 rows (`overage_cents`, `overage_status`, `overage_invoice_id`, `overage_invoice_url` = 4).
- [ ] **Step 4: Commit** `git add supabase/migrations/20261004000001_stripe_catalog_overage.sql && git commit -m "Add Stripe catalog and overage columns"`

---

### Task 2: Overage math (TDD)

**Files:** Create `netlify/functions/_shared/overage.ts`, `netlify/functions/_shared/overage.test.ts`

**Interfaces — Produces:** `computeOverageCents(weightTons: number, limitTons: number | null, ratePerTonCents: number): number`

- [ ] **Step 1: Write the failing test** (`overage.test.ts`)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOverageCents } from "./overage.ts";

test("under or at the limit is free", () => {
  assert.equal(computeOverageCents(1.2, 1.5, 9000), 0);
  assert.equal(computeOverageCents(1.5, 1.5, 9000), 0);
});
test("over the limit is prorated per ton and rounded to the cent", () => {
  assert.equal(computeOverageCents(1.87, 1.5, 9000), 3330);
  assert.equal(computeOverageCents(2.5, 1.5, 9000), 9000);
});
test("bad input yields 0", () => {
  assert.equal(computeOverageCents(NaN, 1.5, 9000), 0);
  assert.equal(computeOverageCents(-3, 1.5, 9000), 0);
  assert.equal(computeOverageCents(2, null, 9000), 0);
  assert.equal(computeOverageCents(2, 1.5, 0), 0);
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test netlify/functions/_shared/overage.test.ts` → "Cannot find module ./overage.ts".
- [ ] **Step 3: Implement** (`overage.ts`)

```ts
// Overage = tons over the included limit x rate per ton, in whole cents.
export function computeOverageCents(weightTons: number, limitTons: number | null, ratePerTonCents: number): number {
  if (!Number.isFinite(weightTons) || weightTons <= 0) return 0;
  if (limitTons == null || !(ratePerTonCents > 0)) return 0;
  const over = weightTons - limitTons;
  if (over <= 0) return 0;
  return Math.round(over * ratePerTonCents);
}
```

- [ ] **Step 4: Run, expect PASS** (3 tests). Note `1.87-1.5` floating error: 0.37×9000 = 3330.0000000000005 → rounds to 3330. ✔
- [ ] **Step 5: Commit** `git add netlify/functions/_shared/overage.* && git commit -m "Add overage math with tests"`

---

### Task 3: Catalog sync module

**Files:** Create `netlify/functions/_shared/stripe-catalog.ts`

**Interfaces — Consumes:** `stripe()` from `./stripe`, `supabaseAdmin()` from `./supabase`. **Produces:**
- `syncType(typeId: string): Promise<void>` — upserts Product for the type and a Price per `duration_price_tiers` row (or one Price from `base_price_cents` for flat types).
- `syncAddon(addonId: string): Promise<void>`
- `ensureFixedProduct(key: "deposit"|"overage"|string, name: string): Promise<string>` — returns Stripe product id (used by checkout and invoices).
- `syncAll(): Promise<{ ok: number; failed: { id: string; error: string }[] }>`
- `productIdForType(typeId: string): Promise<string>`; `productIdForAddon(addonId: string): Promise<string>`.

- [ ] **Step 1: Implement**

```ts
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
```

- [ ] **Step 2: Typecheck**: `npm run typecheck` → no errors.
- [ ] **Step 3: Commit** `git add netlify/functions/_shared/stripe-catalog.ts && git commit -m "Add Stripe catalog sync module"`

---

### Task 4: Wire sync into admin saves + "Sync all" endpoint and UI

**Files:** Modify `netlify/functions/admin-inventory.ts` (cases `create_type`, `update_type`, `upsert_tier`, `create_addon`, `update_addon`, `delete_type`); create `netlify/functions/admin-stripe-sync.ts`; modify `admin/admin.js` (Inventory tab, near `renderTypes`, line ~440, and add-ons list).

**Interfaces — Consumes:** `syncType`, `syncAddon`, `syncAll` (Task 3). **Produces:** POST `/api/admin-stripe-sync` body `{ scope: "all" | "type" | "addon", id?: string }` → `{ ok: number, failed: [...] }`.

- [ ] **Step 1: Add a best-effort wrapper in `admin-inventory.ts`** (a sync failure must not fail the save):

```ts
import { syncType, syncAddon } from "./_shared/stripe-catalog";
async function trySync(fn: () => Promise<void>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { console.error("[stripe sync]", (e as Error).message); return (e as Error).message; }
}
```

Then in each case, after the successful DB write and before `return`, call e.g. in `create_type`/`update_type`: `const syncError = await trySync(() => syncType(data.id));` and return `json({ type: data, stripe_sync_error: syncError })`; in `upsert_tier`: `trySync(() => syncType(body.type_id))`; in `create_addon`/`update_addon`: `trySync(() => syncAddon(data.id))`; in `delete_type` (soft delete): `trySync(() => syncType(body.id))` so the Product is archived.

- [ ] **Step 2: Create `admin-stripe-sync.ts`**

```ts
import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { syncAll, syncType, syncAddon } from "./_shared/stripe-catalog";
import { audit } from "./_shared/audit";

export default adminHandler("admin", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { scope, id } = await readJson<{ scope?: "all" | "type" | "addon"; id?: string }>(req);
  if (scope === "type" && id) { await syncType(id); return json({ ok: 1, failed: [] }); }
  if (scope === "addon" && id) { await syncAddon(id); return json({ ok: 1, failed: [] }); }
  if (scope !== "all") return badRequest("scope must be all, type or addon");
  const result = await syncAll();
  await audit({ actor: user.email!, action: "stripe.sync_all", entity: "stripe", detail: result as unknown as Record<string, unknown> });
  return json(result);
});
```

- [ ] **Step 3: Admin UI.** In `admin/admin.js` Inventory tab header (next to `#add-type`) add `${isAdmin ? '<button class="btn btn-ghost btn-sm" id="sync-stripe">Sync all to Stripe</button>' : ""}` and bind:

```js
$("#sync-stripe")?.addEventListener("click", async (e) => {
  e.target.disabled = true;
  try { const r = await post("admin-stripe-sync", { scope: "all" });
    toast(r.failed.length ? `Synced ${r.ok}, ${r.failed.length} failed` : `Synced ${r.ok} items to Stripe`);
  } catch (err) { alert(err.message); }
  render("inventory");
});
```

In each type card summary add a status badge: `<span class="badge b-${t.stripe_sync_error ? "unpaid" : t.stripe_product_id ? "confirmed" : "pending"}">${t.stripe_sync_error ? "Stripe: error" : t.stripe_product_id ? "in Stripe" : "not in Stripe"}</span>`. After `update_type`/`create_type`/`upsert_tier`/`create_addon` saves, if the response has `stripe_sync_error`, `toast("Saved, but Stripe sync failed: " + msg)`.

- [ ] **Step 4: Verify in test mode:** deploy preview or `netlify dev`; click "Sync all". Expected: Stripe test dashboard → Products shows each type, each add-on, "Booking deposit", "Weight overage", "Distance fee"; 14 Yard Roll-Off has 5 Prices ($339/$369/$419/$539/$739). Click again → no duplicates. Change a tier price → old Price archived, new one active.
- [ ] **Step 5: Commit** `git commit -am "Sync inventory and pricing to Stripe catalog from admin"` (add new file first).

---

### Task 5: Checkout — catalog Products, Stripe Tax, saved card

**Files:** Modify `netlify/functions/create-booking.ts` (`stripe().checkout.sessions.create`, ~line 292).

**Interfaces — Consumes:** `productIdForType`, `productIdForAddon`, `ensureFixedProduct` (Task 3). Quote fields: `quote.subtotal_cents`, `quote.discount_cents`, `quote.distance_fee_cents`, `quote.deposit_cents`, `addons` (`name`, `price_cents`, `qty`), `choice`.

Design note (deviation from the spec's "reference Price IDs"): use `price_data: { product: <catalog product id>, unit_amount }` instead of Price IDs. Stripe reports still group revenue by Product, and arbitrary amounts keep promos, contractor discounts and partial deposits working. The catalog Prices exist for visibility and future use.

- [ ] **Step 1: Build lines.** Our own tax is no longer charged; Stripe adds tax. Replace the single `line_items` entry:

```ts
const typeProduct = await productIdForType(t.id);
const exclusive = (product: string, unit_amount: number) =>
  ({ quantity: 1, price_data: { currency: "usd" as const, unit_amount, tax_behavior: "exclusive" as const, product } });

// Taxable base before tax: base + add-ons - discounts, then distance fee.
const netAddon = quote.addon_cents;
const netMain = Math.max(0, quote.subtotal_cents - quote.addon_cents - quote.discount_cents);
let lines;
if (choice === "card_deposit") {
  lines = [exclusive(await ensureFixedProduct("deposit", "Booking deposit"), quote.deposit_cents)];
} else {
  lines = [exclusive(typeProduct, netMain)];
  for (const a of addons) lines.push(exclusive(await productIdForAddon(a.id), a.price_cents * a.qty));
  if (quote.distance_fee_cents) lines.push(exclusive(await ensureFixedProduct("distance_fee", "Distance fee"), quote.distance_fee_cents));
}
```

Add `id` to the `AddonSelection` objects built at line ~133 (`id: a.id`) and to the `AddonSelection` interface in `pricing.ts` (`id?: string`). If an add-on has no id (admin-created), skip the per-item line and fold into `netMain`.

- [ ] **Step 2: Session options.**

```ts
const session = await stripe().checkout.sessions.create({
  mode: "payment",
  customer_email: body.customer_email,
  customer_creation: "always",
  billing_address_collection: "required",
  automatic_tax: { enabled: true },
  payment_intent_data: { setup_future_usage: "off_session" },
  line_items: lines,
  metadata: { booking_id: booking.id, charge_kind: choice === "card_deposit" ? "deposit" : "full" },
  success_url: `${siteUrl()}/book/confirm.html?ref=${booking.reference}`,
  cancel_url: `${siteUrl()}/book/?canceled=${booking.reference}`,
  expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
});
```

Remove the now-unused `chargeNow` use in the line item. Keep the booking row's `amount_total_cents` as our estimate until the webhook overwrites it (Task 6).

- [ ] **Step 3: Verify (test mode).** Book 1-day roll-off with `4242 4242 4242 4242`. Expected: Stripe checkout shows line "14 Yard Roll-Off $339.00", a tax line, total = $339 + Stripe-calculated tax; the saved-card consent text appears at Stripe; the Product in Stripe's dashboard shows the payment.
- [ ] **Step 4: Commit** `git commit -am "Checkout: catalog products, Stripe Tax, save card for overage"`

---

### Task 6: Webhook — store card, reconcile tax/total

**Files:** Modify `netlify/functions/stripe-webhook.ts` (`checkout.session.completed` branch).

- [ ] **Step 1:** After `const pi = ...`, retrieve the saved payment method and Stripe totals:

```ts
let paymentMethodId: string | null = null;
if (pi) {
  const intent = await stripe().paymentIntents.retrieve(pi);
  paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? null;
}
const stripeTax = session.total_details?.amount_tax ?? 0;
```

Include `stripe_payment_method_id: paymentMethodId` in both `assignUnitAndConfirm(...)` extras and the `parkErr` update (extend the accepted patch type in `_shared/confirm.ts` if it whitelists columns). After confirmation, for `full` payments also `await db.from("bookings").update({ tax_cents: stripeTax, amount_total_cents: paid }).eq("id", booking.id)` so reports match Stripe; for `deposit` update only `tax_cents` is skipped (the balance is settled separately).

- [ ] **Step 2: Verify:** after the Task 5 test booking the `bookings` row shows `stripe_customer_id`, `stripe_payment_method_id` (`pm_...`), `amount_paid_cents` = Stripe total, `tax_cents` = Stripe tax.
- [ ] **Step 3: Commit** `git commit -am "Webhook: save payment method and Stripe tax totals"`

---

### Task 7: Record weight + create overage invoice

**Files:** Create `netlify/functions/admin-record-weight.ts`; modify `netlify/functions/_shared/email.ts` (add `overageNoticeHtml`).

**Interfaces — Consumes:** `computeOverageCents` (Task 2), `ensureFixedProduct` (Task 3), `sendEmail`. **Produces:** POST `/api/admin-record-weight` `{ booking_id, weight_tons, confirm?: boolean }` → without `confirm`: `{ overage_cents, weight_tons, limit_tons }` (preview); with `confirm: true`: creates the invoice and returns `{ overage_cents, invoice_url }`.

- [ ] **Step 1: Add the email template** to `email.ts`:

```ts
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
```

- [ ] **Step 2: Implement the endpoint**

```ts
import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { computeOverageCents } from "./_shared/overage";
import { ensureFixedProduct } from "./_shared/stripe-catalog";
import { sendEmail, overageNoticeHtml } from "./_shared/email";
import { audit } from "./_shared/audit";

export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const body = await readJson<{ booking_id?: string; weight_tons?: number; confirm?: boolean }>(req);
  const weight = Number(body.weight_tons);
  if (!body.booking_id || !Number.isFinite(weight) || weight < 0) return badRequest("booking_id and weight_tons required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (b.overage_status === "paid") return badRequest("Overage already paid");
  const { data: t } = await db.from("dumpster_types").select("weight_limit_tons,overage_fee_cents").eq("id", b.type_id).maybeSingle();
  const limit = t?.weight_limit_tons != null ? Number(t.weight_limit_tons) : null;
  const overage = computeOverageCents(weight, limit, t?.overage_fee_cents ?? 0);

  if (!body.confirm) return json({ overage_cents: overage, weight_tons: weight, limit_tons: limit });

  await db.from("bookings").update({ weight_tons: weight, overage_cents: overage, overage_status: overage > 0 ? "due" : "none" }).eq("id", b.id);
  if (overage === 0) {
    await audit({ actor: user.email!, action: "overage.none", entity: "bookings", entityId: b.id, detail: { weight } });
    return json({ overage_cents: 0, invoice_url: null });
  }
  if (!b.stripe_customer_id) return badRequest("No Stripe customer on this booking (cash or quote). Collect the overage manually.");
  if (b.overage_invoice_id) return badRequest("An overage invoice already exists. Waive it first to re-bill.");

  const s = stripe();
  const invoice = await s.invoices.create({
    customer: b.stripe_customer_id, collection_method: "send_invoice", days_until_due: 7,
    auto_advance: false, automatic_tax: { enabled: true },
    description: `Weight overage — booking ${b.reference}`,
    metadata: { booking_id: b.id, kind: "overage" },
  });
  await s.invoiceItems.create({
    customer: b.stripe_customer_id, invoice: invoice.id, currency: "usd", quantity: 1,
    description: `Overage: ${weight} tons (limit ${limit}) — ${b.reference}`,
    price_data: { currency: "usd", unit_amount: overage, tax_behavior: "exclusive", product: await ensureFixedProduct("overage", "Weight overage") },
  });
  const final = await s.invoices.finalizeInvoice(invoice.id);
  await db.from("bookings").update({ overage_invoice_id: final.id, overage_invoice_url: final.hosted_invoice_url }).eq("id", b.id);
  // Stripe does not email invoices in test mode, so we send our own notice with the hosted pay link.
  await sendEmail(b.customer_email, `Weight overage — ${b.reference}`,
    overageNoticeHtml({ reference: b.reference, customer_name: b.customer_name, weight_tons: weight, limit_tons: limit ?? 0, amount_cents: overage, pay_url: final.hosted_invoice_url!, has_card: !!b.stripe_payment_method_id }));
  await audit({ actor: user.email!, action: "overage.invoice", entity: "bookings", entityId: b.id, detail: { weight, overage, invoice: final.id } });
  return json({ overage_cents: overage, invoice_url: final.hosted_invoice_url });
});
```

- [ ] **Step 3: Typecheck** `npm run typecheck`; **Step 4: Commit** `git add netlify/functions/admin-record-weight.ts && git commit -am "Admin: record weight and bill overage via Stripe invoice"`

---

### Task 8: Charge saved card, waive, and invoice webhooks

**Files:** Create `netlify/functions/admin-charge-overage.ts`; modify `netlify/functions/stripe-webhook.ts` (add `invoice.paid`, `invoice.payment_failed`); modify `email.ts` if a receipt template is wanted (reuse `sendEmail` with a short HTML body).

**Interfaces — Produces:** POST `/api/admin-charge-overage` `{ booking_id, action: "charge" | "waive" }` → `{ ok: true, status }`.

- [ ] **Step 1: Implement**

```ts
import { adminHandler } from "./_shared/admin";
import { json, badRequest, notFound, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { stripe } from "./_shared/stripe";
import { audit } from "./_shared/audit";

export default adminHandler("staff", async (req, user) => {
  if (req.method !== "POST") return badRequest("POST required");
  const { booking_id, action } = await readJson<{ booking_id?: string; action?: "charge" | "waive" }>(req);
  if (!booking_id || (action !== "charge" && action !== "waive")) return badRequest("booking_id and action required");
  const db = supabaseAdmin();
  const { data: b } = await db.from("bookings").select("*").eq("id", booking_id).maybeSingle();
  if (!b) return notFound("Booking not found");
  if (!b.overage_invoice_id) return badRequest("No overage invoice for this booking");
  const s = stripe();
  const inv = await s.invoices.retrieve(b.overage_invoice_id);
  if (inv.status === "paid") return badRequest("Already paid");   // prevents double charge

  if (action === "waive") {
    if (inv.status === "open") await s.invoices.voidInvoice(inv.id);
    await db.from("bookings").update({ overage_status: "waived" }).eq("id", b.id);
    await audit({ actor: user.email!, action: "overage.waive", entity: "bookings", entityId: b.id });
    return json({ ok: true, status: "waived" });
  }
  if (!b.stripe_payment_method_id) return badRequest("No saved card on this booking");
  try {
    await s.invoices.pay(inv.id, { payment_method: b.stripe_payment_method_id, off_session: true });
  } catch (err) {
    await audit({ actor: user.email!, action: "overage.charge_failed", entity: "bookings", entityId: b.id, detail: { error: (err as Error).message } });
    return badRequest(`Card charge failed: ${(err as Error).message}`);
  }
  await audit({ actor: user.email!, action: "overage.charge", entity: "bookings", entityId: b.id });
  return json({ ok: true, status: "paid" });   // webhook records the payment row
});
```

- [ ] **Step 2: Webhook.** Inside the `try` in `stripe-webhook.ts`, add:

```ts
if (event.type === "invoice.paid") {
  const inv = event.data.object as Stripe.Invoice;
  const bookingId = inv.metadata?.booking_id;
  if (inv.metadata?.kind === "overage" && bookingId) {
    const { data: existing } = await db.from("payments").select("id").eq("booking_id", bookingId).eq("kind", "overage").eq("note", inv.id).maybeSingle();
    if (!existing) {
      await db.from("payments").insert({ booking_id: bookingId, kind: "overage", method: "card", amount_cents: inv.amount_paid, status: "succeeded", note: inv.id });
    }
    await db.from("bookings").update({ overage_status: "paid" }).eq("id", bookingId);
  }
  return new Response("ok", { status: 200 });
}
if (event.type === "invoice.payment_failed") {
  const inv = event.data.object as Stripe.Invoice;
  if (inv.metadata?.kind === "overage" && inv.metadata?.booking_id) {
    const { data: bk } = await db.from("bookings").select("flags").eq("id", inv.metadata.booking_id).maybeSingle();
    const flags = new Set<string>(bk?.flags ?? []); flags.add("overage_payment_failed");
    await db.from("bookings").update({ flags: [...flags] }).eq("id", inv.metadata.booking_id);
  }
  return new Response("ok", { status: 200 });
}
```

The `payments` insert is idempotent on `(booking_id, kind='overage', note=invoice id)`, so a repeated event adds no second row.

- [ ] **Step 3: Owner action (Stripe dashboard, test mode):** add `invoice.paid` and `invoice.payment_failed` to the webhook endpoint's events. Document this in `docs/DEPLOY.md`.
- [ ] **Step 4: Commit** `git add netlify/functions/admin-charge-overage.ts && git commit -am "Charge saved card, waive overage, invoice webhooks"`

---

### Task 9: Admin booking drawer UI

**Files:** Modify `admin/admin.js` (`openBooking` drawer template ~line 296–330 and its click handlers).

- [ ] **Step 1: Template.** Add a Dumpster-only block after the Payment row inside `<dl class="dl">`:

```js
${b.service === "dumpster" && b.payment_method === "card" ? `<dt>Weight</dt><dd>
  ${b.weight_tons != null ? `${b.weight_tons} tons · overage ${money(b.overage_cents)} ${badge(b.overage_status)}` : '<span class="muted">Not recorded</span>'}
  ${b.overage_invoice_url ? `<br><a href="${b.overage_invoice_url}" target="_blank" rel="noopener">Customer pay link</a>` : ""}</dd>` : ""}
```

and actions in `.drawer-actions`:

```js
${b.service === "dumpster" && b.payment_method === "card" && b.overage_status !== "paid" ? `<button class="btn btn-ghost btn-sm" data-act="record-weight">Record weight</button>` : ""}
${b.overage_status === "due" ? `<button class="btn btn-primary btn-sm" data-act="charge-overage" ${b.stripe_payment_method_id ? "" : "disabled title='No saved card'"}>Charge saved card</button>
  <button class="btn btn-ghost btn-sm" data-act="waive-overage">Waive</button>` : ""}
```

- [ ] **Step 2: Handlers** (follow the existing `data-act` pattern in the same function):

```js
if (act === "record-weight") {
  const w = parseFloat(prompt("Scale weight in tons (e.g. 1.87):"));
  if (!(w >= 0)) return;
  const prev = await post("admin-record-weight", { booking_id: b.id, weight_tons: w });
  if (!prev.overage_cents) { await post("admin-record-weight", { booking_id: b.id, weight_tons: w, confirm: true }); toast("Recorded — no overage"); return openBooking(b.id); }
  if (!confirm(`Weight ${w} t, limit ${prev.limit_tons} t. Overage ${money(prev.overage_cents)} plus tax. Email the customer a pay link?`)) return;
  await post("admin-record-weight", { booking_id: b.id, weight_tons: w, confirm: true });
  toast("Overage invoice emailed"); return openBooking(b.id);
}
if (act === "charge-overage") {
  if (!confirm("Charge the saved card for the overage now?")) return;
  try { await post("admin-charge-overage", { booking_id: b.id, action: "charge" }); toast("Charged"); } catch (e) { alert(e.message); }
  return openBooking(b.id);
}
if (act === "waive-overage") {
  if (!confirm("Waive this overage?")) return;
  await post("admin-charge-overage", { booking_id: b.id, action: "waive" }); return openBooking(b.id);
}
```

Also add `stripe_payment_method_id,weight_tons,overage_cents,overage_status,overage_invoice_url` to the `select` list in `netlify/functions/admin-bookings.ts` (line 36) so the drawer receives them.

- [ ] **Step 3: Verify (test mode):** record 1.87 tons on the test booking (limit 1.5, $90/ton) → preview "$33.30 plus tax" → confirm → customer email arrives with Pay link; the Stripe test invoice shows overage + tax. Click "Charge saved card" → drawer shows `paid` after the webhook; clicking again is refused ("Already paid"). Repeat with card `4000 0000 0000 0341` as the saved card (new booking) → "Card charge failed", status stays `due`, Pay link still works.
- [ ] **Step 4: Commit** `git commit -am "Admin: weight and overage controls in booking drawer"`

---

### Task 10: Site copy, consent, docs

**Files:** Modify `book/booking.js` (`renderSummary`), `book/index.html` (payment step), `supabase/seed.sql`/agreement note, `docs/DEPLOY.md`.

- [ ] **Step 1:** In `renderSummary`, relabel card-mode tax row to `Estimated tax` and add a line under the total: `Final tax is calculated at checkout.`
- [ ] **Step 2:** In `book/index.html` payment step add under the pay options: `<p class="hint" id="card-consent">Your card will be saved securely with Stripe. If your load goes over the included weight, you will be emailed the overage amount first and may be charged to this card as described in your rental agreement.</p>`; hide it when `quote` (same place `#stripe-note` is toggled). Note in the plan hand-off that the owner's attorney must confirm this wording and that the agreement's Section 6 already covers additional charges.
- [ ] **Step 3:** `docs/DEPLOY.md`: add Stripe Tax prerequisite, the two extra webhook events, and "Sync all to Stripe" step.
- [ ] **Step 4: Verify** a full test booking: review screen shows "Estimated tax" and the consent line; Stripe total matches; cleanout quote path unchanged (no consent line, no Stripe note, "Estimated total (before tax)").
- [ ] **Step 5: Commit** `git commit -am "Booking copy: estimated tax and card-on-file consent"`

---

## Self-review

- **Spec coverage:** catalog sync (T3–4), checkout with Stripe Tax and saved card (T5–6), overage record/invoice/charge/waive (T7–9), consent/docs (T10), testing steps inside each task. Spec §2 "Our 8.25% stays as estimate" → T10 step 1.
- **Deviation recorded:** line items use `price_data.product` instead of Price IDs (T5 note) so promos/deposits keep working; Prices are still synced.
- **Types consistent:** `computeOverageCents` (T2→T7), `ensureFixedProduct`/`productIdFor*` (T3→T5/T7), `overage_status` values `none|due|paid|waived` (T1→T7–9), `stripe_payment_method_id` (T1→T6→T8–9).
- **Owner actions required:** push webhook events (T8), confirm consent wording with attorney (T10), Stripe Tax already enabled.
