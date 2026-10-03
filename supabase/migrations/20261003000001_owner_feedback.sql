-- ============================================================
--  Owner call feedback (Oct 2026): carousel slides, contractor
--  accounts, referral source, bilingual + verified agreements,
--  customer-tracker support.
-- ============================================================

-- ---------- ON SITE carousel (admin editable, orderable, optional promo window) ----------
create table if not exists site_slides (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  badge       text,                 -- e.g. "LIMITED TIME"
  image_url   text,                 -- public URL (uploaded via admin or external)
  bullets     text,                 -- one checklist line per row
  price_label text,                 -- e.g. "starting at"
  price_text  text,                 -- e.g. "$419" (ignored when live_price)
  live_price  boolean not null default false, -- show the live 7-day catalog price
  cta_label   text,
  cta_url     text,
  starts_on   date,                 -- null = no start limit
  ends_on     date,                 -- null = no end (temporary promos set this)
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_site_slides_updated before update on site_slides
  for each row execute function set_updated_at();
alter table site_slides enable row level security;
drop policy if exists p_slides_public_read on site_slides;
create policy p_slides_public_read on site_slides for select using (active = true);

-- public bucket for slide images
insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;

-- ---------- contractors (no login; number + admin approval) ----------
create table if not exists contractors (
  id                uuid primary key default gen_random_uuid(),
  contractor_number text not null unique,
  company_name      text not null,
  contact_name      text not null,
  email             text not null,
  phone             text not null,
  license_info      text,           -- license / EIN / website used to verify they are a contractor
  status            text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  admin_notes       text,
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists idx_contractors_email on contractors(lower(email));
create trigger trg_contractors_updated before update on contractors
  for each row execute function set_updated_at();
alter table contractors enable row level security;  -- service role only

-- ---------- bookings: referral, contractor link, verification trail ----------
alter table bookings
  add column if not exists referral_source        text,
  add column if not exists contractor_id          uuid references contractors(id) on delete set null,
  add column if not exists agreement_lang         text not null default 'en',
  add column if not exists agreement_body_hash    text,   -- sha256 of the exact text shown + signed
  add column if not exists agreement_user_agent   text,
  add column if not exists agreement_signature    text,   -- drawn signature, PNG data URL
  add column if not exists agreement_ack          jsonb,  -- which acknowledgements were ticked
  add column if not exists agreement_code_hash    text,   -- hash of emailed verification code
  add column if not exists agreement_code_expires timestamptz,
  add column if not exists agreement_verified_at  timestamptz; -- email code confirmed
create index if not exists idx_bookings_contractor on bookings(contractor_id);
create index if not exists idx_bookings_referral   on bookings(referral_source);

-- ---------- agreement: Spanish copy alongside English ----------
alter table agreement_templates
  add column if not exists title_es     text,
  add column if not exists body_html_es text;

-- ---------- default owner shift (2 on / 4 off, first shift Oct 6 2026) ----------
insert into settings (key, value) values
  ('owner_shift', '{"enabled": true, "anchor_date": "2026-10-06", "on_days": 2, "off_days": 4}'),
  ('referral_sources', '["Google search","Facebook / Instagram","Friend or family","Contractor / builder","Yard sign or truck","Nextdoor","Repeat customer","Other"]')
on conflict (key) do nothing;

-- default carousel slide = the existing "7-Day Rental" card (live price from the catalog)
insert into site_slides (title, body, badge, bullets, price_label, live_price, cta_label, cta_url, sort_order)
select '7-Day Rental',
       'Our most popular option for residential cleanouts and remodels.',
       'On-site in 24 hrs',
       E'14-yard roll-off dumpster\nDelivery + pickup included\nUp to 1.5 tons (3,000 lb) disposal\n0–15 mile delivery zone included',
       'starting at', true, 'View All Pricing', '#pricing', 1
where not exists (select 1 from site_slides);
