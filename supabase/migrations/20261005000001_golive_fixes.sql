-- Go-live fixes (2026-10-05)

-- Contact + alert email: the old texasdumpco.com domain does not exist.
update settings set value = '"texasdumpsterco@gmail.com"'
where key in ('company_email', 'alert_email')
  and value::text like '%texasdumpco.com%';

-- Balance invoices (deposit remainder, or a finalized phone quote).
alter table bookings
  add column if not exists balance_invoice_id text,
  add column if not exists balance_invoice_url text;

-- The admin refund and the charge.refunded webhook can race; never ledger a refund twice.
create unique index if not exists idx_payments_stripe_refund_id
  on payments(stripe_refund_id) where stripe_refund_id is not null;

-- Customer photo uploads: images only, 15 MB cap.
update storage.buckets
set file_size_limit = 15728640,
    allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif']
where id = 'booking-uploads';

-- Blackouts apply to every type that shares the same physical containers
-- (standard, green waste and heavy material all use the 14-yard pool).
create or replace function is_blacked_out(p_type uuid, p_start date, p_end date)
returns boolean language sql stable as $$
  select exists (
    select 1 from blackouts bl
    where (bl.scope = 'all' or bl.type_id in (select pool_type_ids(p_type)))
      and bl.start_at::date <= p_end
      and bl.end_at::date   >= p_start
  );
$$;
