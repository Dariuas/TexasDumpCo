# Texas Dumpster Co — Booking & Back Office Setup

This system runs on the existing Netlify site plus three services the **client owns**:
Supabase (database, auth, file storage), Stripe (payments), and Google Calendar (job schedule).
Email is optional via Resend. This guide takes you from empty accounts to a live booking system.

> You only need to do this once. Nothing charges real money until you switch Stripe to **live** keys.

---

## 1. Supabase (database + auth + storage)

1. Create a project at <https://supabase.com>. Pick a region close to Texas (e.g. `us-east-1`).
2. In **Project Settings → API**, copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (secret — server only)
3. Apply the schema. Easiest with the Supabase CLI from the repo root:
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push          # runs everything in supabase/migrations
   psql "$DATABASE_URL" -f supabase/seed.sql   # optional starter data
   ```
   (Or paste each file in `supabase/migrations/` then `supabase/seed.sql` into the SQL editor, in order.)
4. The migrations create a private storage bucket `booking-uploads` automatically.

### Create your admin login
1. In **Authentication → Users**, add a user with your email (set a password or send a magic link).
2. In the **SQL editor**, promote that user to admin:
   ```sql
   insert into profiles (user_id, role, full_name)
   select id, 'admin', 'Owner' from auth.users where email = 'you@example.com'
   on conflict (user_id) do update set role = 'admin';
   ```
   Add staff the same way with `'staff'` (staff can manage bookings but not settings/pricing).

---

## 2. Stripe (payments)

1. Create an account at <https://stripe.com>. Start in **Test mode** (toggle top-right).
2. **Developers → API keys**: copy `Secret key` → `STRIPE_SECRET_KEY`, `Publishable key` → `STRIPE_PUBLISHABLE_KEY`.
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://<your-site>.netlify.app/api/stripe-webhook`
   - Events: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`
4. When you're ready for real payments, redo steps 2–3 in **Live mode** and swap the keys.

Local testing forwards webhooks with the Stripe CLI:
```bash
stripe listen --forward-to localhost:8888/api/stripe-webhook
```

---

## 3. Google Calendar (job schedule)

1. In **Google Cloud Console**, create a project and enable the **Google Calendar API**.
2. Create a **Service Account**; under its **Keys**, add a JSON key and download it.
3. Put the entire JSON (single line) into `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. In Google Calendar, open the calendar you want jobs on → **Settings → Share with specific people**
   → add the service account's `client_email` with **"Make changes to events"**.
5. Copy that calendar's **Calendar ID** (Settings → Integrate calendar) → `GOOGLE_CALENDAR_ID`.

> If these two vars are left blank, bookings still work — calendar sync is just skipped.

---

## 4. Email (optional, recommended)

1. Create a <https://resend.com> account, verify your sending domain.
2. API key → `RESEND_API_KEY`. Set `EMAIL_FROM` (e.g. `Texas Dumpster Co <bookings@texasdumpco.com>`).
3. Without a key, the app logs emails instead of sending them.

---

## 5. Netlify environment variables

In **Site configuration → Environment variables**, add all of the below, then redeploy:

| Variable | From |
| --- | --- |
| `SUPABASE_URL` | Supabase API |
| `SUPABASE_ANON_KEY` | Supabase API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase API (secret) |
| `STRIPE_SECRET_KEY` | Stripe API keys (secret) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook endpoint |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account key (optional) |
| `GOOGLE_CALENDAR_ID` | Google Calendar settings (optional) |
| `RESEND_API_KEY` | Resend (optional) |
| `EMAIL_FROM` | your verified sender (optional) |
| `ADMIN_ALERT_EMAIL` | where new-booking alerts go |
| `SITE_URL` | `https://<your-site>.netlify.app` |

---

## 6. Local development

```bash
npm install
netlify dev          # serves the site + functions at http://localhost:8888
```
Create a `.env` in the repo root with the same variables for local runs (git-ignored).
Use Stripe **test cards** (e.g. `4242 4242 4242 4242`, any future expiry/CVC).

---

## 7. Go-live checklist

- [ ] Migrations + seed applied; admin user promoted.
- [ ] Real dumpster types, pricing, and inventory units entered in **/admin → Inventory & Pricing**.
- [ ] Cash payments toggle set as desired in **/admin → Settings**.
- [ ] Stripe switched to **Live** keys; webhook re-created in Live mode.
- [ ] Google Calendar shared with the service account; a test booking shows up.
- [ ] Do one real end-to-end booking with a live card, then refund it from **/admin → Bookings**.
- [ ] Update the homepage "Book Online" links (they already point to `/book`).
