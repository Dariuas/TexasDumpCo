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

| Variable | Value / source |
| --- | --- |
| `SUPABASE_URL` | `https://mlrlviixzavfegdghpfk.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase API (secret) |
| `STRIPE_SECRET_KEY` | client — `sk_test_…` |
| `STRIPE_PUBLISHABLE_KEY` | client — `pk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook — `whsec_…` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | client — full JSON on one line |
| `GOOGLE_CALENDAR_ID` | client |
| `RESEND_API_KEY` | optional |
| `EMAIL_FROM` | optional, e.g. `Texas Dumpster Co <bookings@texasdumpco.com>` |
| `ADMIN_ALERT_EMAIL` | where new-booking alerts go |
| `SITE_URL` | `https://texasdumpco.netlify.app` |

> Missing Google/Resend vars degrade gracefully (calendar/email just skip). Missing Supabase or
> Stripe vars will break booking — those three Supabase keys + the Stripe keys are the must-haves.

## Stripe webhook endpoint
Create in Stripe (Developers → Webhooks) pointing at the deployed site:
- URL: `https://texasdumpco.netlify.app/api/stripe-webhook`
- Events: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`
- Signing secret → `STRIPE_WEBHOOK_SECRET`

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
6. Flip Stripe to **Live** keys + live webhook, do one real card booking + immediate refund, then
   you're production-ready.
