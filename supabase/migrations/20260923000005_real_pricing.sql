-- ============================================================
--  Real pricing model, matching the TXD Master Pricing & Phone
--  Call Guide (14-yard roll-off, duration-tier pricing, junk
--  hauling by load volume, add-ons, distance zones, quote-only
--  services for phone-judgment work).
-- ============================================================

-- ---------- dumpster_types: pricing mode + grouping + shared equipment ----------
alter table dumpster_types add column if not exists category text not null default 'general';
alter table dumpster_types add column if not exists pricing_mode text not null default 'flat';
  -- 'flat'            : single price (junk load-volume tiers, yard-waste full-service)
  -- 'duration_tiers'   : priced by rental length (14-yard roll-off, clean green-waste roll-off)
  -- 'quote_only'       : phone-judgment pricing (cleanouts, heavy material, contractor accounts) —
  --                      booking is captured but not charged online; staff finalizes the price.
alter table dumpster_types add column if not exists price_note text;
  -- display hint, e.g. 'Starting at' for quote_only / ranged services
alter table dumpster_types add column if not exists uses_inventory boolean not null default true;
  -- false for crew/truck-based services (junk hauling, cleanouts) that aren't tied to a numbered unit
alter table dumpster_types add column if not exists equipment_pool text;
  -- types sharing the same physical containers (e.g. standard vs. clean-load roll-off) share a pool
  -- so availability is computed across the whole pool, not double-counted per type.

do $$ begin
  alter table dumpster_types add constraint chk_pricing_mode
    check (pricing_mode in ('flat','duration_tiers','quote_only'));
exception when duplicate_object then null; end $$;

-- ---------- duration-based pricing tiers ----------
create table if not exists duration_price_tiers (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references dumpster_types(id) on delete cascade,
  days int not null,
  price_cents int not null,
  label text,                      -- e.g. '7 Days - Most Popular'
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique(type_id, days)
);

-- ---------- add-on items (mattress, appliance, tire, access fees...) ----------
create table if not exists addon_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'specialty',   -- specialty | appliance | access | fee
  price_cents int not null,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists booking_addons (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  addon_item_id uuid references addon_items(id) on delete set null,
  name text not null,              -- snapshot, survives addon edits/deletes
  price_cents int not null,        -- snapshot
  qty int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_booking_addons_booking on booking_addons(booking_id);

-- ---------- distance + addon totals on the booking ----------
alter table bookings add column if not exists distance_zone text;
alter table bookings add column if not exists distance_fee_cents int not null default 0;
alter table bookings add column if not exists addon_cents int not null default 0;

-- ---------- RLS ----------
alter table duration_price_tiers enable row level security;
alter table addon_items enable row level security;
alter table booking_addons enable row level security;

drop policy if exists p_duration_tiers_public_read on duration_price_tiers;
create policy p_duration_tiers_public_read on duration_price_tiers for select using (true);

drop policy if exists p_addon_items_public_read on addon_items;
create policy p_addon_items_public_read on addon_items for select using (active = true);
-- booking_addons has no anon policy: server/admin only, like payments/audit_log.

-- ---------- shared-equipment-pool availability ----------
-- Resolves the set of type_ids that share physical inventory with p_type
-- (its own equipment_pool label, or just itself if it doesn't share a pool).
create or replace function pool_type_ids(p_type uuid)
returns setof uuid language sql stable as $$
  select id from dumpster_types
  where equipment_pool is not null
    and equipment_pool = (select equipment_pool from dumpster_types where id = p_type)
  union
  select p_type
  where not exists (
    select 1 from dumpster_types where id = p_type and equipment_pool is not null
  );
$$;

create or replace function bookable_unit_count(p_type uuid)
returns int language sql stable as $$
  select count(*)::int
  from inventory_units u
  where u.type_id in (select pool_type_ids(p_type))
    and u.status in ('available', 'in_service');
$$;

create or replace function booked_unit_count(p_type uuid, p_start date, p_end date)
returns int language sql stable as $$
  select count(*)::int
  from bookings b
  where b.type_id in (select pool_type_ids(p_type))
    and b.status <> 'canceled'
    and b.start_date <= p_end
    and b.end_date   >= p_start
    and (b.status <> 'pending' or (b.hold_expires_at is not null and b.hold_expires_at > now()));
$$;

-- try_reserve_capacity also needs to lock/count across the pool, not just p_type.
create or replace function try_reserve_capacity(p_booking uuid)
returns boolean language plpgsql as $$
declare
  v_type uuid; v_start date; v_end date; v_avail int; v_pool_key text;
begin
  select type_id, start_date, end_date into v_type, v_start, v_end
  from bookings where id = p_booking for update;

  select coalesce(equipment_pool, v_type::text) into v_pool_key from dumpster_types where id = v_type;
  perform pg_advisory_xact_lock(hashtext(v_pool_key));

  select greatest(0,
    case when is_blacked_out(v_type, v_start, v_end) then 0
    else bookable_unit_count(v_type) - (
      select count(*)::int from bookings b
      where b.type_id in (select pool_type_ids(v_type)) and b.id <> p_booking
        and b.status <> 'canceled'
        and b.start_date <= v_end and b.end_date >= v_start
        and (b.status <> 'pending' or (b.hold_expires_at is not null and b.hold_expires_at > now()))
    ) end) into v_avail;

  return v_avail > 0;
end;
$$;
