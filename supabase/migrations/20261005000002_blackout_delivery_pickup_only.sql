-- Blackouts (owner shifts, holidays) block only the days the truck has to come out:
-- delivery (start_date) and pickup (end_date). A container may sit at the customer's
-- site across blackout days. Pool-aware: covers every type sharing the containers.
create or replace function is_blacked_out(p_type uuid, p_start date, p_end date)
returns boolean language sql stable as $$
  select exists (
    select 1 from blackouts bl
    where (bl.scope = 'all' or bl.type_id in (select pool_type_ids(p_type)))
      and (
        (bl.start_at::date <= p_start and bl.end_at::date >= p_start)
        or (bl.start_at::date <= p_end and bl.end_at::date >= p_end)
      )
  );
$$;
