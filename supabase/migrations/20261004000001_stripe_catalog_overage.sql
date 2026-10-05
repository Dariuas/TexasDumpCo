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
