-- Homepage quote requests with customer photos (previously Netlify-form only).
create table if not exists quote_requests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text not null,
  email         text not null,
  service       text,
  zip           text,
  details       text,
  referral_source text,
  photo_paths   jsonb not null default '[]'::jsonb,  -- paths in the private booking-uploads bucket
  status        text not null default 'new' check (status in ('new','contacted','booked','closed')),
  admin_notes   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_quote_requests_updated before update on quote_requests
  for each row execute function set_updated_at();
alter table quote_requests enable row level security;  -- service role only
create index if not exists idx_quote_requests_created on quote_requests(created_at desc);
