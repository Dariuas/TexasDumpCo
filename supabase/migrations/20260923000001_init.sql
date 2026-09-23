-- ============================================================
--  Texas Dumpster Co — booking + back office schema
--  Postgres / Supabase. All money stored in integer cents.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- enums ----------
do $$ begin
  create type service_kind      as enum ('dumpster', 'junk');
  create type unit_status       as enum ('available', 'in_service', 'maintenance', 'out_of_service');
  create type booking_status    as enum ('pending', 'confirmed', 'scheduled', 'delivered', 'picked_up', 'completed', 'canceled');
  create type payment_method    as enum ('card', 'cash');
  create type payment_status    as enum ('unpaid', 'deposit_paid', 'paid', 'refunded', 'partially_refunded', 'cash_pending');
  create type payment_kind      as enum ('full', 'deposit', 'balance', 'refund');
  create type txn_status         as enum ('pending', 'succeeded', 'failed', 'canceled', 'refunded');
  create type photo_kind         as enum ('delivery_site', 'junk_items', 'drop_off', 'pickup', 'other');
  create type uploader_kind      as enum ('customer', 'staff');
  create type promo_kind         as enum ('percent', 'fixed');
  create type user_role          as enum ('admin', 'staff', 'customer');
  create type blackout_scope     as enum ('all', 'type');
exception when duplicate_object then null; end $$;

-- ---------- helper: updated_at ----------
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ---------- profiles (roles for auth.users) ----------
create table if not exists profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       user_role not null default 'customer',
  created_at timestamptz not null default now()
);

-- ---------- dumpster / service types (pricing lives here) ----------
create table if not exists dumpster_types (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  service              service_kind not null default 'dumpster',
  size_yards           int,
  description          text,
  base_price_cents     int not null default 0,       -- rental base or junk minimum
  deposit_cents        int not null default 0,       -- fixed deposit; 0 => use settings.deposit_percent
  rental_days_included int not null default 7,
  extra_day_fee_cents  int not null default 0,
  weight_limit_tons    numeric(5,2),
  overage_fee_cents    int not null default 0,        -- per ton over the limit
  sort_order           int not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_dumpster_types_updated before update on dumpster_types
  for each row execute function set_updated_at();

-- ---------- physical inventory units ----------
create table if not exists inventory_units (
  id         uuid primary key default gen_random_uuid(),
  type_id    uuid not null references dumpster_types(id) on delete restrict,
  label      text not null,                     -- asset tag / unit name
  status     unit_status not null default 'available',
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_inventory_units_updated before update on inventory_units
  for each row execute function set_updated_at();
create index if not exists idx_units_type on inventory_units(type_id);

-- ---------- promo codes ----------
create table if not exists promo_codes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  kind          promo_kind not null,
  value         int not null,                    -- percent (1-100) or fixed cents
  min_amount_cents int not null default 0,
  max_uses      int,                             -- null = unlimited
  uses_count    int not null default 0,
  applies_to    service_kind,                    -- null = any service
  starts_at     timestamptz,
  ends_at       timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_promo_codes_updated before update on promo_codes
  for each row execute function set_updated_at();

-- ---------- agreement templates ----------
create table if not exists agreement_templates (
  id         uuid primary key default gen_random_uuid(),
  version    int not null,
  title      text not null default 'Rental Agreement',
  body_html  text not null,
  active     boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_agreement_one_active
  on agreement_templates(active) where active;

-- ---------- blackout windows ----------
create table if not exists blackouts (
  id         uuid primary key default gen_random_uuid(),
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  scope      blackout_scope not null default 'all',
  type_id    uuid references dumpster_types(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  check (scope = 'all' or type_id is not null)
);
create index if not exists idx_blackouts_range on blackouts(start_at, end_at);

-- ---------- key/value settings ----------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger trg_settings_updated before update on settings
  for each row execute function set_updated_at();

-- ---------- bookings ----------
create table if not exists bookings (
  id                 uuid primary key default gen_random_uuid(),
  reference          text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  service            service_kind not null default 'dumpster',
  user_id            uuid references auth.users(id) on delete set null,  -- null = guest

  customer_name      text not null,
  customer_email     text not null,
  customer_phone     text not null,

  delivery_address   text not null,
  delivery_lat       numeric(9,6),
  delivery_lng       numeric(9,6),
  delivery_notes     text,

  type_id            uuid not null references dumpster_types(id) on delete restrict,
  unit_id            uuid references inventory_units(id) on delete set null,  -- assigned on confirm

  start_date         date not null,
  end_date           date not null,
  time_window        text,                          -- e.g. 'AM', 'PM', '8-10'

  status             booking_status not null default 'pending',
  payment_method     payment_method not null default 'card',
  payment_status     payment_status not null default 'unpaid',

  subtotal_cents     int not null default 0,
  discount_cents     int not null default 0,
  tax_cents          int not null default 0,
  amount_total_cents int not null default 0,
  amount_paid_cents  int not null default 0,
  deposit_cents      int not null default 0,

  promo_code_id      uuid references promo_codes(id) on delete set null,

  agreement_version  int,
  agreement_signed_name text,
  agreement_signed_at   timestamptz,
  agreement_signed_ip   text,

  flags              jsonb not null default '[]'::jsonb,  -- e.g. ["hazardous","overweight"]
  notes              text,                                 -- customer description of the job
  admin_notes        text,

  stripe_customer_id           text,
  stripe_checkout_session_id   text,
  stripe_payment_intent_id     text,
  google_event_id              text,

  hold_expires_at    timestamptz,                    -- inventory hold for pending bookings
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date >= start_date)
);
create trigger trg_bookings_updated before update on bookings
  for each row execute function set_updated_at();
create index if not exists idx_bookings_dates  on bookings(start_date, end_date);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_type   on bookings(type_id);
create index if not exists idx_bookings_email  on bookings(customer_email);

-- ---------- booking photos ----------
create table if not exists booking_photos (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references bookings(id) on delete cascade,
  kind        photo_kind not null default 'other',
  storage_path text not null,                    -- path in the 'booking-uploads' bucket
  uploaded_by uploader_kind not null default 'customer',
  created_at  timestamptz not null default now()
);
create index if not exists idx_photos_booking on booking_photos(booking_id);

-- ---------- payments / refunds ledger ----------
create table if not exists payments (
  id                        uuid primary key default gen_random_uuid(),
  booking_id                uuid not null references bookings(id) on delete cascade,
  kind                      payment_kind not null,
  method                    payment_method not null default 'card',
  amount_cents              int not null,          -- refunds stored as positive amounts with kind='refund'
  status                    txn_status not null default 'pending',
  stripe_payment_intent_id  text,
  stripe_refund_id          text,
  note                      text,
  created_at                timestamptz not null default now()
);
create index if not exists idx_payments_booking on payments(booking_id);

-- ---------- audit log ----------
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor      text,                                -- user email or 'system'
  action     text not null,
  entity     text,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_entity on audit_log(entity, entity_id);
