# Weight overage billing, Stripe catalog sync, and Stripe Tax — design

Date: 2026-10-04. Status: awaiting owner review. Stripe stays in **test mode** for all build and testing; live keys are never touched.

## Goals (as agreed with the owner)

1. Charge the base price at booking and keep the customer's card on file so a weight overage can be collected later.
2. Notify the customer of the overage in advance, with a Pay button. Staff can also charge the saved card. **Manual only**: nothing is charged without a staff click.
3. Everything we sell exists in Stripe's Product Catalog (one Product per item, one Price per rental length), created and updated automatically from the Inventory and Pricing tab, so Stripe reports show revenue by item.
4. Tax is calculated and reported by **Stripe Tax**.

## Non-goals

- Automatic charging after a grace period (rejected; may be added later as a setting).
- Changing any price or the rental-length pricing model.
- Writing the attorney-drafted agreement wording (owner's attorney confirms the card-on-file clause).

## Current state (relevant facts)

- Checkout is `stripe.checkout.sessions.create` in `netlify/functions/create-booking.ts` with inline `price_data` (name only, no catalog Product). The webhook `stripe-webhook.ts` records payments.
- `dumpster_types` already has `weight_limit_tons` and `overage_fee_cents` (per ton). Rental lengths live in `duration_price_tiers`; add-ons in `addon_items`. Payments are ledgered in `payments`.
- Tax is computed in our code (`pricing.ts`, `tax_rate_bps` setting, now 825) and folded into one lump charge.

## Design

### 1. Catalog sync

- Migration adds `stripe_product_id` to `dumpster_types` and `addon_items`, and `stripe_price_id` to `duration_price_tiers` (plus one for `base_price` on types without tiers, and for the distance-fee, deposit and overage products stored in `settings` or a small `stripe_catalog` table).
- New `_shared/stripe-catalog.ts`: `syncType(id)`, `syncAddon(id)`, `syncAll()`. Creates the Product if missing, updates name/description/active, and creates a new Price when the amount changes (Stripe Prices are immutable) then archives the old one. Idempotent; safe to re-run.
- Products carry a Stripe tax code and `metadata.source_id` pointing back to our row.
- The existing admin save endpoints (`admin-inventory.ts` and the add-on save path) call the sync after a successful write. A sync failure never blocks the save; it sets a visible "Stripe sync failed" flag with a retry.
- Admin Inventory and Pricing tab gets a "Sync all to Stripe" button for existing items and a per-item sync status.
- Checkout line items reference `price: stripe_price_id` instead of inline `price_data`. Deposits, distance fees and the overage use their own catalog Products.

### 2. Stripe Tax

- Checkout sets `automatic_tax: { enabled: true }`, collects the billing address, and uses tax-exclusive prices.
- Our 8.25% setting stays as an **estimate only**. The review screen reads "Estimated tax — final amount calculated at checkout". Stripe's figure is what is charged and reported.
- **Owner prerequisite in the Stripe dashboard (test, later live):** enable Stripe Tax, set the head-office address, add the Texas registration. Code cannot do this.
- Risk: Stripe's tax may differ from the estimate (local rates, taxability of the service). The customer sees the final amount at Stripe before paying. Mitigation: the estimate is labeled; the discrepancy is visible during test bookings.

### 3. Weight overage (card on file, manual)

- Checkout (card payments) sets `customer_creation: "always"` and `payment_intent_data.setup_future_usage: "off_session"`. The webhook stores `stripe_customer_id` and the payment method on the booking.
- New columns on `bookings`: `weight_tons`, `overage_cents`, `overage_status` (`none | due | paid | waived`), `overage_invoice_id`.
- New admin endpoint `admin-record-weight`: staff enter the scale weight. The system computes `max(0, tons − weight_limit_tons) × overage_fee_cents`, shows the amount for confirmation, then creates a Stripe **Invoice** (overage Product line, automatic tax) with `collection_method: "send_invoice"` and emails the customer. The email's Pay button is Stripe's hosted invoice page.
- New admin endpoint `admin-charge-overage`: pays that invoice with the saved card (`invoices.pay` using the booking's payment method). Explicit staff action only; requires the saved card; records success or failure.
- The webhook handles `invoice.paid` and `invoice.payment_failed`, updates `overage_status`, writes a `payments` row (kind `overage`), and emails a receipt. Idempotent per invoice.
- Admin booking drawer shows weight, overage amount, status, and the two buttons (Record weight / Charge saved card). A waive option sets `overage_status = waived` and voids the invoice.
- All actions write to `audit_log`.

### 4. Consent

The card step gets a clear line: the card will be saved and may be charged for weight overage and other charges authorized in the agreement. Final legal wording to be confirmed by the owner's attorney.

### 5. Error handling

- Missing saved card: charge button disabled with an explanation; customer can still pay via the emailed link.
- Card declined: invoice stays open, status stays `due`, staff see the failure reason; the emailed Pay link still works.
- Stripe API failures during sync or invoice creation surface as admin errors and are retryable; no partial state is silently kept.

### 6. Testing (test mode only)

- Unit-test the overage math (limit, rounding, zero overage).
- Catalog: create, edit price, archive; confirm Stripe shows one Product and the expected Prices.
- Walk: roll-off booking (card saved, tax line appears) → record weight → invoice email → pay via hosted page → status `paid`; second run → charge saved card; third → declined card (`4000 0000 0000 0341`) path.
- Regression: cleanout quote path and cash path unchanged; prices on the site unchanged.

## Decisions to confirm in review

- Stripe Tax requires the dashboard setup above before it will compute tax.
- Distance fees, deposits and add-ons are catalog Products too.
