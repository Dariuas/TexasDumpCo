-- ============================================================
--  Small RPCs used by the app
-- ============================================================

-- Atomically consume one promo use.
create or replace function increment_promo_use(p_id uuid)
returns void language sql as $$
  update promo_codes set uses_count = uses_count + 1 where id = p_id;
$$;

-- Release inventory holds on abandoned pending bookings (call from a cron/
-- scheduled function, or manually). Cancels pending bookings whose hold lapsed.
create or replace function expire_stale_holds()
returns int language plpgsql as $$
declare n int;
begin
  with expired as (
    update bookings set status = 'canceled'
    where status = 'pending'
      and hold_expires_at is not null
      and hold_expires_at < now()
    returning id
  )
  select count(*) into n from expired;
  return n;
end;
$$;
