-- ============================================================
--  Seed data — matches the TXD Master Pricing & Phone Call Guide
--  (14-yard roll-off, duration-tier pricing; junk hauling by load
--  volume; cleanouts/heavy-material/contractor work quote-only).
--  Money is in cents. Idempotent: safe to re-run on a fresh DB.
--  "Starting" / range prices are launch suggestions — verify
--  disposal-site fees before publishing, per the source guide.
-- ============================================================

-- ---------- business settings ----------
insert into settings (key, value) values
  ('company_name',     '"Texas Dumpster Co"'),
  ('company_phone',    '"(512) 337-4340"'),
  ('company_email',    '"bookings@texasdumpco.com"'),
  ('deposit_percent',  '25'),
  ('tax_rate_bps',     '825'),
  ('lead_time_days',   '1'),
  ('per_day_cap',      '0'),
  ('cash_accepted',    'false'),
  ('booking_window_days', '120'),
  ('time_windows',     '["Morning (8a-12p)","Afternoon (12p-5p)","Anytime"]'),
  ('alert_email',      '"bookings@texasdumpco.com"'),
  -- self-reported delivery distance, since the site has no live mileage lookup —
  -- mirrors the guide's own phone question "where is the job?"
  ('distance_zones', '[
    {"code":"zone1","label":"0-15 miles (included)","fee_cents":0,"quote_only":false},
    {"code":"zone2","label":"16-25 miles","fee_cents":3500,"quote_only":false},
    {"code":"zone3","label":"26-35 miles","fee_cents":6500,"quote_only":false},
    {"code":"zone4","label":"Beyond 35 miles","fee_cents":0,"quote_only":true}
  ]'),
  -- admin-facing reference only (Section B / Section I) — contractor pricing is
  -- earned by judgment/relationship, not self-serve, so it is not in the public
  -- catalog. Staff apply it via a manual booking (admin-create-booking).
  ('contractor_rate_card', '{
    "standard_7day_cents": 38900,
    "volume_4_7_cents": 37900,
    "volume_8plus_cents": 36900,
    "jobsite_28day_cents": 68900,
    "dump_and_return_cents": 29900,
    "green_7day_cents": 34900,
    "green_volume_4_7_cents": 33900,
    "green_volume_8plus_cents": 32900,
    "green_dump_and_return_cents": 28900,
    "note": "Section B/C of the phone guide. Standard new contractor: quote 7-day $389. After 4+ real rentals/mo move to $379; reserve $369 for 8+/mo accounts."
  }'),
  -- admin-facing reference for judgment/condition fees (Section G/H) — applied
  -- manually as an admin note / price adjustment, not auto-charged.
  ('fee_schedule_reference', '{
    "dry_run_or_inaccessible_cents": 12500,
    "late_cancellation_lt24h_cents": 7500,
    "truck_already_dispatched_cents": 12500,
    "overfill_rearrangement_from_cents": 7500,
    "long_carry_from_cents": 5000,
    "stairs_from_cents": 2500,
    "multi_floor_heavy_furniture_from_cents": 7500,
    "same_day_priority_from_cents": 5000,
    "after_hours_from_cents": 7500
  }')
on conflict (key) do update set value = excluded.value;

-- ---------- 14-yard roll-off (standard + clean green-waste share one equipment pool) ----------
insert into dumpster_types
  (name, service, category, pricing_mode, size_yards, description, base_price_cents, deposit_cents,
   rental_days_included, extra_day_fee_cents, weight_limit_tons, overage_fee_cents,
   equipment_pool, uses_inventory, price_note, sort_order)
values
  ('14 Yard Roll-Off', 'dumpster', 'roll_off_standard', 'duration_tiers', 14,
   'Residential cleanouts, remodels, DIY projects and general debris. You load it, we deliver and pick up.',
   33900, 0, 7, 1500, 1.5, 9000, '14yd-rolloff', true, 'Starting at', 1),

  ('14 Yard Roll-Off — Clean Green Waste', 'dumpster', 'roll_off_green', 'duration_tiers', 14,
   'Tree limbs, branches, brush, leaves and untreated natural wood only — one qualifying clean load per rental.',
   31900, 0, 7, 1500, null, 0, '14yd-rolloff', true, 'Starting at', 2)
on conflict do nothing;

-- ---------- duration pricing tiers (Section A / Section C) ----------
insert into duration_price_tiers (type_id, days, price_cents, label, sort_order)
select t.id, v.days, v.price_cents, v.label, v.sort_order
from dumpster_types t
join (values
  (1, 33900, '1 Day - Quick Load', 1),
  (3, 36900, '3 Days', 2),
  (7, 41900, '7 Days - Most Popular', 3),
  (14, 53900, '14 Days', 4),
  (28, 73900, '28 Days', 5)
) as v(days, price_cents, label, sort_order) on true
where t.name = '14 Yard Roll-Off'
on conflict (type_id, days) do nothing;

insert into duration_price_tiers (type_id, days, price_cents, label, sort_order)
select t.id, v.days, v.price_cents, v.label, v.sort_order
from dumpster_types t
join (values
  (1, 31900, '1 Day', 1),
  (3, 33900, '3 Days', 2),
  (7, 37900, '7 Days', 3),
  (14, 47900, '14 Days', 4),
  (28, 63900, '28 Days', 5)
) as v(days, price_cents, label, sort_order) on true
where t.name = '14 Yard Roll-Off — Clean Green Waste'
on conflict (type_id, days) do nothing;

-- ---------- junk hauling — household, by load volume (Section D) ----------
insert into dumpster_types
  (name, service, category, pricing_mode, description, base_price_cents, uses_inventory, sort_order)
values
  ('Junk Hauling — Minimum Pickup', 'junk', 'junk_household', 'flat', 'A single item or small amount — our crew loads and hauls it away.', 14900, false, 10),
  ('Junk Hauling — 1/4 Load', 'junk', 'junk_household', 'flat', 'About a quarter truck load of household junk.', 24900, false, 11),
  ('Junk Hauling — 1/2 Load', 'junk', 'junk_household', 'flat', 'Half truck load — garage or room cleanout.', 39900, false, 12),
  ('Junk Hauling — 3/4 Load', 'junk', 'junk_household', 'flat', 'Three-quarter truck load.', 54900, false, 13),
  ('Junk Hauling — Full Load', 'junk', 'junk_household', 'flat', 'Full truck — whole-home or estate cleanout.', 69900, false, 14)
on conflict do nothing;

-- ---------- yard waste & brush, full-service hauling (Section E.3) — ranged, so quote-only ----------
insert into dumpster_types
  (name, service, category, pricing_mode, description, base_price_cents, uses_inventory, price_note, sort_order)
values
  ('Yard Waste Hauling — Full Service', 'junk', 'junk_yard_waste', 'quote_only',
   'Our crew loads and hauls away brush, branches and yard debris — no dumpster required. Price depends on load size.',
   14900, false, 'Starting at', 20)
on conflict do nothing;

-- ---------- cleanout services (Section G) — starting ranges, phone-quoted ----------
insert into dumpster_types
  (name, service, category, pricing_mode, description, base_price_cents, uses_inventory, price_note, sort_order)
values
  ('Garage Cleanout', 'junk', 'junk_cleanout', 'quote_only', 'Full garage cleanout, crew-loaded.', 29900, false, 'Starting at', 30),
  ('Apartment Cleanout', 'junk', 'junk_cleanout', 'quote_only', 'Full apartment cleanout, crew-loaded.', 39900, false, 'Starting at', 31),
  ('House Cleanout', 'junk', 'junk_cleanout', 'quote_only', 'Full house or estate cleanout, crew-loaded.', 69900, false, 'Starting at', 32),
  ('Storage Unit Cleanout — Small', 'junk', 'junk_cleanout', 'quote_only', 'Small storage unit, crew-loaded.', 24900, false, 'Starting at', 33),
  ('Storage Unit Cleanout — Medium', 'junk', 'junk_cleanout', 'quote_only', 'Medium storage unit, crew-loaded.', 39900, false, 'Starting at', 34),
  ('Storage Unit Cleanout — Large / Full', 'junk', 'junk_cleanout', 'quote_only', 'Large or full storage unit, crew-loaded.', 69900, false, 'Starting at', 35)
on conflict do nothing;

-- ---------- heavy-material roll-offs (Section F) — weight-based, phone-quoted, shares the roll-off pool ----------
insert into dumpster_types
  (name, service, category, pricing_mode, description, base_price_cents, uses_inventory, equipment_pool, price_note, sort_order)
values
  ('Heavy Material Roll-Off — Concrete / Brick / Dirt / Soil', 'dumpster', 'heavy_material', 'quote_only',
   'Dense material priced by weight, not container size. $249 up to ~1,000 lb, then +$125 per additional 1,000 lb.',
   24900, true, '14yd-rolloff', 'Starting at', 40),
  ('Heavy Material Roll-Off — Rock / Gravel / Tile', 'dumpster', 'heavy_material', 'quote_only',
   'Dense material priced by weight. $249 minimum, then +$125-$140 per additional 1,000 lb.',
   24900, true, '14yd-rolloff', 'Starting at', 41),
  ('Heavy Material Roll-Off — Roofing Shingles', 'dumpster', 'heavy_material', 'quote_only',
   'Priced by weight. $299 up to ~1,000 lb, then +$140 per additional 1,000 lb.',
   29900, true, '14yd-rolloff', 'Starting at', 42),
  ('Heavy Material Roll-Off — Drywall / Sheetrock', 'dumpster', 'heavy_material', 'quote_only',
   'Priced by weight. $225 minimum, then +$110-$125 per additional 1,000 lb.',
   22500, true, '14yd-rolloff', 'Starting at', 43)
on conflict do nothing;

-- ---------- inventory units (physical 14-yard containers; shared via equipment_pool) ----------
insert into inventory_units (type_id, label, status)
select t.id, '14yd Container #' || gs, 'available'
from dumpster_types t, generate_series(1, 4) gs
where t.name = '14 Yard Roll-Off'
  and not exists (select 1 from inventory_units u where u.type_id = t.id);

-- ---------- add-on items (Sections D/E/G — most common specialty items & access fees) ----------
insert into addon_items (name, category, price_cents, sort_order) values
  ('Mattress', 'specialty', 3500, 1),
  ('Box Spring', 'specialty', 3500, 2),
  ('Mattress + Box Spring Set', 'specialty', 6500, 3),
  ('Refrigerator / Freezer', 'appliance', 5000, 4),
  ('TV / Monitor', 'appliance', 2500, 5),
  ('Passenger Tire', 'specialty', 2000, 6),
  ('Truck Tire', 'specialty', 3000, 7),
  ('Long Carry to Truck', 'access', 5000, 8),
  ('Stairs Involved', 'access', 2500, 9),
  ('Heavy Item (250+ lb)', 'access', 7500, 10)
on conflict do nothing;

-- ---------- agreement template v1 ----------
insert into agreement_templates (version, title, body_html, active)
select 1, 'Rental Agreement',
$html$
<h3>Texas Dumpster Co — Rental Agreement</h3>
<p>By signing below you agree to the following terms:</p>
<ul>
  <li><strong>Placement:</strong> You are responsible for providing a clear, legal, and accessible drop-off location. Damage to driveways, sprinklers, or private surfaces is not the responsibility of Texas Dumpster Co.</li>
  <li><strong>Prohibited items:</strong> No hazardous waste, asbestos, medical/biohazard waste, explosives, radioactive material, unknown chemicals, or other regulated hazardous waste. Prohibited items may incur additional fees.</li>
  <li><strong>Weight limits:</strong> Standard roll-off loads include 1.5 tons (3,000 lb). Loads over that are billed at $90/ton, prorated by scale weight. Heavy material (concrete, brick, dirt, rock, tile, roofing shingles) is priced separately by weight and does not use the standard overage rate.</li>
  <li><strong>Fill level:</strong> Debris must be level with or below the top rail and secured for legal transport. If a load is unsafe to transport, you must remove or rearrange material before pickup; a handling or dry-run fee may apply.</li>
  <li><strong>Rental period &amp; extensions:</strong> Additional days beyond the included period are billed at the posted daily rate.</li>
  <li><strong>Cancellations &amp; refunds:</strong> Cancellations made before delivery are eligible for a refund less any processing fees. Late cancellations (under 24 hours) or a truck already dispatched may incur a fee. Deposits may be non-refundable within 24 hours of the scheduled delivery.</li>
</ul>
<p>You certify that you are authorized to place a dumpster or request a pickup at the delivery address provided.</p>
$html$,
  true
where not exists (select 1 from agreement_templates where version = 1);
