# What We Need From You — Booking System Setup

Hi! To finish connecting the new online booking + payment system to **Texas Dumpster Co**, we need a
few keys and settings from the accounts you already created (Google and Stripe). This guide walks you
through finding each one. It looks like a lot, but each step is just "copy a value and send it back."

**How to send them to us:** copy each value into a reply (email or text is fine). These are sensitive —
please don't post them publicly. If anything looks confusing, take a screenshot and we'll sort it out.

There are **three sections**: Google Calendar, Stripe (payments), and a quick confirmation list at the end.

---

## 1. Google Calendar — so bookings show up on your calendar

We need three things from Google: a **service account key file**, the **calendar ID**, and for you to
**share your calendar** with that service account. This lets the website automatically drop every new
booking onto your Google Calendar.

### Step 1a — Create the service account key (one time)
1. Go to **https://console.cloud.google.com** and sign in with the Google account that owns the business calendar.
2. At the top, make sure a **project** is selected (any project is fine — if you see "Select a project," pick one or create one called "Texas Dumpster Co").
3. In the search bar at the top, type **"Service Accounts"** and open it (under *IAM & Admin*).
4. Click **+ Create Service Account**.
   - Name: `booking-calendar`
   - Click **Create and Continue**, then **Done** (you can skip the optional steps).
5. You'll see your new service account in the list. **Copy its email address** — it looks like
   `booking-calendar@your-project.iam.gserviceaccount.com`. You'll need it in Step 1c. ✅ **Send us this email too.**
6. Click the service account, go to the **Keys** tab → **Add Key** → **Create new key** → choose **JSON** → **Create**.
7. A `.json` file downloads to your computer. ✅ **Send us this file** (it's the "service account key").

### Step 1b — Turn on the Calendar API (one time)
1. In the same Google Cloud site, use the top search bar to find **"Google Calendar API"**.
2. Open it and click **Enable** (if it already says "Manage," it's already on — you're good).

### Step 1c — Share your calendar with the service account
1. Go to **https://calendar.google.com**.
2. On the left, hover over the calendar you want bookings to appear on → click the **⋮** (three dots) → **Settings and sharing**.
3. Scroll to **Share with specific people or groups** → **+ Add people and groups**.
4. Paste the service account email from Step 1a (the `...iam.gserviceaccount.com` one).
5. Set permission to **"Make changes to events"** → **Send**.

### Step 1d — Get the Calendar ID
1. Still in that calendar's **Settings and sharing** page, scroll to **Integrate calendar**.
2. Copy the **Calendar ID**. For your main calendar it's usually your email (e.g. `texasdumpsterco@gmail.com`);
   for a secondary calendar it's a long string ending in `@group.calendar.google.com`.
3. ✅ **Send us this Calendar ID.**

---

## 2. Stripe — so customers can pay by card

We need your Stripe **keys** and a **webhook**. Start in **Test mode** so we can test safely before real money moves.

### Step 2a — API keys
1. Go to **https://dashboard.stripe.com** and sign in.
2. Top-right, make sure **Test mode** is toggled **ON** (you'll see a "Test mode" badge).
3. In the left menu go to **Developers → API keys**.
4. Copy the **Publishable key** (starts with `pk_test_...`). ✅ **Send us this.**
5. Next to **Secret key**, click **Reveal**, then copy it (starts with `sk_test_...`). ✅ **Send us this** (keep it private).

### Step 2b — Webhook (tells the site when a payment succeeds)
> If this step feels technical, you can skip it and just tell us — we can set it up once the site is deployed.
1. Go to **Developers → Webhooks → + Add endpoint**.
2. Endpoint URL: we'll give you the exact address once the site is live — it will look like
   `https://texasdumpco.netlify.app/api/stripe-webhook`.
3. Under **Select events**, add: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`.
4. Click **Add endpoint**, then on the endpoint page click **Reveal** under **Signing secret** and copy it
   (starts with `whsec_...`). ✅ **Send us this.**

### Later: going live
When you're ready to take real payments, you'll repeat Steps 2a–2b with **Test mode OFF** (Live mode) and
send us the `pk_live_...`, `sk_live_...`, and the live `whsec_...`. We'll swap them in.

---

## 3. Quick confirmation checklist

Please send us the following. Check each off as you go:

- [ ] **Google service account email** (`...iam.gserviceaccount.com`)
- [ ] **Google service account JSON file** (the download from Step 1a)
- [ ] Calendar API **enabled** (Step 1b)
- [ ] Calendar **shared** with the service account, "Make changes to events" (Step 1c)
- [ ] **Google Calendar ID** (Step 1d)
- [ ] **Stripe publishable key** (`pk_test_...`)
- [ ] **Stripe secret key** (`sk_test_...`)
- [ ] **Stripe webhook signing secret** (`whsec_...`) — or tell us you'd like us to set the webhook up

Once we have these, the online booking, payments, and calendar sync will be fully connected. Thank you!
