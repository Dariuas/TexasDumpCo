# Internal Deploy Runbook (Tim)

Everything the client-facing `CLIENT-CREDENTIALS.md` collects, plus the Supabase side you own,
lands here as Netlify environment variables. This is the go-live checklist.

## Current status

- **Branch:** `feat/back-office` (this work). Not yet merged to `main`.
- **Supabase project:** `mlrlviixzavfegdghpfk` — schema + seed applied and verified, private
  `booking-uploads` bucket created.
- **Admin login:** `texasdumpsterco@gmail.com` / `TexDump!Admin2026` (change after first sign-in;
  admin can't change password in-app yet → use Supabase dashboard "Send password recovery" or reset).
- **DB password:** the Direct connection string was used once to apply migrations — **rotate it**
  (Supabase → Settings → Database → Reset password). App uses the API keys, not the DB password.

## Supabase keys (you)

Supabase → **Settings → API**:

- Project URL → `SUPABASE_URL` = `https://mlrlviixzavfegdghpfk.supabase.co`
- `anon` / publishable key → `SUPABASE_ANON_KEY`
- `service_role` key (secret) → `SUPABASE_SERVICE_ROLE_KEY`

## Netlify environment variables

Site config → **Environment variables**. Paste all of these (values from the two credential docs):

| Variable                      | Value / source                                                |
| ----------------------------- | ------------------------------------------------------------- |
| `SUPABASE_URL`                | `https://mlrlviixzavfegdghpfk.supabase.co`                    |
| `SUPABASE_ANON_KEY`           | Supabase API                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`   | Supabase API (secret)                                         |
| `STRIPE_SECRET_KEY`           | client — `sk_test_…`                                          |
| `STRIPE_PUBLISHABLE_KEY`      | client — `pk_test_…`                                          |
| `STRIPE_WEBHOOK_SECRET`       | Stripe webhook — `whsec_…`                                    |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | client — full JSON on one line                                |
| `GOOGLE_CALENDAR_ID`          | client                                                        |
| `GOOGLE_MAPS_API_KEY`         | client — Google Cloud key with the **Routes API** enabled (see below) |
| `RESEND_API_KEY`              | optional                                                      |
| `EMAIL_FROM`                  | `Texas Dumpster Co <bookings@texasdumpsterco.com>` (must be on the Resend-verified `texasdumpsterco.com` domain) |
| `EMAIL_REPLY_TO`              | optional, defaults to `texasdumpsterco@gmail.com` (customer replies land here) |
| `ADMIN_ALERT_EMAIL`           | fallback for staff alerts; Admin → Settings "alerts to" wins  |
| `SITE_URL`                    | `https://texasdumpsterco.com` (Stripe return URLs)            |

> Missing Google/Resend vars degrade gracefully (calendar/email just skip). Once `RESEND_API_KEY` is set, every
> online booking needs the emailed code, so a bad `EMAIL_FROM` blocks booking: check the function logs for `[email] send failed`. Missing Supabase or
> Stripe vars will break booking — those three Supabase keys + the Stripe keys are the must-haves.

## Stripe webhook endpoint

Create in Stripe (Developers → Webhooks) pointing at the deployed site:

- URL: `https://texasdumpsterco.com/api/stripe-webhook`
- Events: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`, `invoice.paid`, `invoice.payment_failed`
  (the last two reconcile weight-overage and balance invoices)
- Signing secret → `STRIPE_WEBHOOK_SECRET`

## Stripe Tax and catalog

- Sales tax is a Stripe Tax Rate ("Sales Tax", Texas) built from Admin → Settings → tax rate (`tax_rate_bps`,
  825 = 8.25%). Checkout, receipts and invoices show the pre-tax subtotal and a separate Sales Tax line, matching
  the booking page. Changing the setting creates a new Tax Rate automatically on the next charge. Stripe Tax
  (automatic) is not used, so no Stripe Tax registration is required.
- Admin → Inventory & Pricing → **Sync all to Stripe** creates a Stripe Product per type/add-on and a Price per
  rental length. New and edited items sync automatically on save.
- Weight overage: staff use **Record weight** on a dumpster booking; the overage becomes a charge line, the
  customer is emailed a Stripe pay link, and staff may **Charge saved card**. Nothing is charged automatically.

## Quotes, invoices and later charges

- A quote request (homepage form, a quote-only item, a 35+ mile job, or any contractor booking) is priced in the
  booking drawer with **Build invoice & confirm**: itemized lines (rental, mileage, fees, discount). Saving
  confirms the booking and emails the itemized price; **Email pay link** sends a Stripe Checkout link that also
  saves the card. Homepage quote requests become bookings with **Create booking** (Quote Requests tab or
  Contractors → Queue).
- After the job, **+ Add charge** (weight, extra mileage, extra days, a fee from the fee schedule, or other), then
  **Charge saved card** (receipt emailed) or **Email pay link**. Unpaid charges can be removed (their invoice is
  voided). Lines live in `booking_charges`; the booking total follows them.

## Contractors

- Contractors apply on the homepage (or tick "I'm a contractor" when booking / requesting a quote). Applications
  wait in Admin → Contractors → **Queue**; **Approve** assigns the contractor number and emails it.
- Accounts are found by number, phone or email. Contractor online bookings never charge a card: they land in the
  Queue as requests and staff price them with the invoice builder.
- **Tax exempt** (contractor drawer) stores the certificate number and an uploaded copy; their bookings and
  invoices carry no sales tax.

## Distance pricing (Google Maps)

- Admin → Settings → **Delivery distance**: yard address (default 1725 County Road 269, Leander, TX 78641), free
  radius 15 mi, $1.85/mile, online limit 35 mi one way, round trip on. Billed miles = round trip − 2 × radius,
  rounded up. Past the limit the booking becomes a call-for-quote request.
- Needs `GOOGLE_MAPS_API_KEY`: Google Cloud console → APIs & Services → enable **Routes API** → Credentials →
  Create API key → restrict it to the Routes API. Billing must be on; normal volume fits in the monthly free
  credit. Without the key the booking page falls back to the old distance-zone picker.
- Migration `20261006000001_contractor_queue_distance.sql` adds the tables/columns for all of the above.

## Deploy

1. Set all env vars **first** (above).
2. Merge `feat/back-office` → `main` (Netlify auto-deploys `main`). Or open the PR and merge.
   - The marketing site is untouched by this branch except: hero "Book Online" + quiz CTAs now point
     to `/book`, and the Roll Off Amigo iframe is replaced by a native "Book Online Now" button.
3. After deploy, the new surfaces are:
   - Customer booking: `https://texasdumpco.netlify.app/book`
   - Back office: `https://texasdumpco.netlify.app/admin`

## Smoke test (Stripe test mode)

1. Sign in at `/admin` → confirm dashboard loads, Inventory shows the seeded types/units.
2. `/book` → book a 20-yd for a near date → pay with test card `4242 4242 4242 4242` (any future
   expiry, any CVC/ZIP).
3. Confirm: booking appears in `/admin` as **confirmed/paid**, a Google Calendar event was created,
   and (if Resend set) a confirmation email arrived.
4. In `/admin`, open the booking → **Refund** a few dollars → confirm it shows in payment history.
5. Toggle **Settings → Accept cash = Yes**, book again choosing cash → approve it from the dashboard.
6. Flip Stripe to **Live**:
   - In Stripe **Live** mode, add the webhook (same URL and all five events as above) and copy its
     signing secret.
   - In Netlify, set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` to
     the live values, then trigger a redeploy (env changes apply only to new deploys).
   - Open `/admin` → Inventory → **Sync all**. The site notices the key changed from test to live
     on its own and re-creates the products, prices and sales-tax rate in live mode. Old test
     bookings keep test-mode Stripe ids: don't refund or bill them after the switch.
   - Do one real card booking + immediate refund, then you're production-ready.
