-- ============================================================
--  Storage bucket + availability helpers
-- ============================================================

-- Private bucket for customer/staff photos. All access brokered by
-- the server via signed URLs, so no public storage policies are added.
insert into storage.buckets (id, name, public)
values ('booking-uploads', 'booking-uploads', false)
on conflict (id) do nothing;

-- Bookings that tie up inventory for a given type over a date range.
-- (pending holds count only while the hold is still alive.)
create or replace function booked_unit_count(p_type uuid, p_start date, p_end date)
returns int language sql stable as $$
  select count(*)::int
  from bookings b
  where b.type_id = p_type
    and b.status <> 'canceled'
    and b.start_date <= p_end
    and b.end_date   >= p_start
    and (b.status <> 'pending' or (b.hold_expires_at is not null and b.hold_expires_at > now()));
$$;

-- Is the whole [start,end] window inside a blackout for this type?
create or replace function is_blacked_out(p_type uuid, p_start date, p_end date)
returns boolean language sql stable as $$
  select exists (
    select 1 from blackouts bl
    where (bl.scope = 'all' or bl.type_id = p_type)
      and bl.start_at::date <= p_end
      and bl.end_at::date   >= p_start
  );
$$;

-- Units of a type that can physically be rented.
create or replace function bookable_unit_count(p_type uuid)
returns int language sql stable as $$
  select count(*)::int
  from inventory_units u
  where u.type_id = p_type
    and u.status in ('available', 'in_service');
$$;

-- Remaining availability for a type over a window (>=0).
create or replace function type_availability(p_type uuid, p_start date, p_end date)
returns int language sql stable as $$
  select greatest(
    0,
    case when is_blacked_out(p_type, p_start, p_end) then 0
         else bookable_unit_count(p_type) - booked_unit_count(p_type, p_start, p_end)
    end
  );
$$;

-- Atomically confirm capacity for a booking and return true if room remains.
-- Called inside the webhook/confirm path; SERIALIZABLE-safe via advisory lock
-- on the type so two confirmations can't race past the last unit.
create or replace function try_reserve_capacity(p_booking uuid)
returns boolean language plpgsql as $$
declare
  v_type uuid; v_start date; v_end date; v_avail int;
begin
  select type_id, start_date, end_date into v_type, v_start, v_end
  from bookings where id = p_booking for update;

  perform pg_advisory_xact_lock(hashtext(v_type::text));

  -- availability excluding THIS booking (so re-confirm is idempotent)
  select greatest(0,
    case when is_blacked_out(v_type, v_start, v_end) then 0
    else bookable_unit_count(v_type) - (
      select count(*)::int from bookings b
      where b.type_id = v_type and b.id <> p_booking
        and b.status <> 'canceled'
        and b.start_date <= v_end and b.end_date >= v_start
        and (b.status <> 'pending' or (b.hold_expires_at is not null and b.hold_expires_at > now()))
    ) end) into v_avail;

  return v_avail > 0;
end;
$$;
