-- ============================================================
--  Row Level Security
--  Server-side Netlify Functions use the SERVICE ROLE key and
--  bypass RLS entirely. The browser only ever uses the ANON key,
--  so these policies define exactly what an unauthenticated or
--  logged-in *customer* may read. Admin/staff data is served only
--  through role-checked functions, never the anon client.
-- ============================================================

alter table profiles           enable row level security;
alter table dumpster_types     enable row level security;
alter table inventory_units    enable row level security;
alter table promo_codes        enable row level security;
alter table agreement_templates enable row level security;
alter table blackouts          enable row level security;
alter table settings           enable row level security;
alter table bookings           enable row level security;
alter table booking_photos     enable row level security;
alter table payments           enable row level security;
alter table audit_log          enable row level security;

-- Public catalog: anyone may read the active, bookable types.
drop policy if exists p_types_public_read on dumpster_types;
create policy p_types_public_read on dumpster_types
  for select using (active = true);

-- Public: the active agreement template (shown before signing).
drop policy if exists p_agreement_public_read on agreement_templates;
create policy p_agreement_public_read on agreement_templates
  for select using (active = true);

-- Own profile.
drop policy if exists p_profile_self_read on profiles;
create policy p_profile_self_read on profiles
  for select using (user_id = auth.uid());

-- Logged-in customers may read their own bookings + photos.
drop policy if exists p_bookings_self_read on bookings;
create policy p_bookings_self_read on bookings
  for select using (user_id = auth.uid());

drop policy if exists p_photos_self_read on booking_photos;
create policy p_photos_self_read on booking_photos
  for select using (
    exists (select 1 from bookings b
            where b.id = booking_photos.booking_id
              and b.user_id = auth.uid())
  );

-- Everything else (inventory, promos, blackouts, settings, payments,
-- audit_log, and all writes) has RLS enabled but NO anon/authenticated
-- policy, so the anon client is denied. Only the service role reaches it.
