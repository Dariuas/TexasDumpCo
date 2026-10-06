-- ============================================================
--  Client feedback (Oct 2026): contractor queue + verification,
--  tax exempt contractors, distance from the yard, itemized
--  booking charges (quote -> invoice -> later adjustments).
-- ============================================================

-- ---------- contractors: number issued on approval, phone lookup, tax exempt ----------
alter table contractors alter column contractor_number drop not null;
alter table contractors
  add column if not exists phone_digits     text,   -- digits only, for lookup by phone
  add column if not exists tax_exempt       boolean not null default false,
  add column if not exists tax_exempt_cert  text,   -- Texas sales tax permit / exemption certificate number
  add column if not exists tax_exempt_file  text,   -- path in the private booking-uploads bucket
  add column if not exists verified_by      text;
update contractors set phone_digits = regexp_replace(phone, '\D', '', 'g') where phone_digits is null;
create index if not exists idx_contractors_phone_digits on contractors(phone_digits);

-- ---------- quote requests: contractor link, address, booking it became ----------
alter table quote_requests
  add column if not exists is_contractor    boolean not null default false,
  add column if not exists contractor_id    uuid references contractors(id) on delete set null,
  add column if not exists delivery_address text,
  add column if not exists booking_id       uuid references bookings(id) on delete set null;
create index if not exists idx_quote_requests_contractor on quote_requests(contractor_id);

-- ---------- bookings: measured distance, tax exempt snapshot ----------
alter table bookings
  add column if not exists distance_miles numeric(7,1),           -- round-trip driving miles from the yard
  add column if not exists tax_exempt     boolean not null default false;

-- ---------- itemized charges per booking ----------
-- stage 'initial'    = the priced quote / invoice the customer pays first
-- stage 'adjustment' = anything added after (weight overage, extra miles, extra days, fees)
create table if not exists booking_charges (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references bookings(id) on delete cascade,
  kind              text not null check (kind in ('rental','mileage','weight','extra_days','fee','custom','discount')),
  description       text not null,
  quantity          numeric(10,2) not null default 1,
  unit_cents        int not null,
  amount_cents      int not null,            -- quantity x unit, negative for a discount
  taxable           boolean not null default true,
  tax_cents         int not null default 0,      -- sales tax on this line (0 when exempt)
  stage             text not null default 'adjustment' check (stage in ('initial','adjustment')),
  -- external = the original online/cash booking amount, collected by the existing
  -- checkout / balance / cash flows; kept here only so totals add up.
  status            text not null default 'draft' check (status in ('draft','invoiced','paid','void','waived','external')),
  stripe_invoice_id text,                        -- Stripe invoice (in_...) or Checkout Session (cs_...) that bills it
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger trg_booking_charges_updated before update on booking_charges
  for each row execute function set_updated_at();
create index if not exists idx_booking_charges_booking on booking_charges(booking_id);
create index if not exists idx_booking_charges_invoice on booking_charges(stripe_invoice_id);
alter table booking_charges enable row level security;  -- service role only

alter type payment_kind add value if not exists 'adjustment';

-- ---------- distance settings (yard + per-mile pricing) ----------
insert into settings (key, value) values
  ('distance_pricing', '{"hub_address": "1725 County Road 269, Leander, TX 78641", "free_radius_miles": 15, "per_mile_cents": 185, "max_oneway_miles": 35, "round_trip": true}')
on conflict (key) do nothing;
