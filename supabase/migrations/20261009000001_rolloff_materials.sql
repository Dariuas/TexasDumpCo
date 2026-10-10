-- ============================================================
--  Client price sheet (Oct 2026): one 14-yard roll-off rental,
--  three material categories the customer picks after the
--  rental length. All share the same physical containers.
--    Standard        339/369/419/539/739, 3,000 lb included, $45 per extra 1,000 lb
--    Heavy materials 339/369/419/539/739, 1,000 lb included, $135 per extra 1,000 lb
--    Yard waste/brush 339/369/419/539/739, 3.5 cu yd included, $18 per extra cu yd
--      (customer picks the load size at booking: 1/2 +$63, 3/4 +$126, full +$189)
--  Safe to run more than once.
-- ============================================================

-- ---------- Standard: weight terms ----------
update dumpster_types
   set weight_limit_tons = 1.5, overage_fee_cents = 9000,
       description = 'Household junk, remodel and construction debris, furniture and general cleanouts. Includes 3,000 lb; additional weight $45 per 1,000 lb.'
 where category = 'roll_off_standard';

-- ---------- Yard waste / brush only (was "Clean Green Waste") ----------
update dumpster_types
   set name = '14 Yard Roll-Off — Yard Waste / Brush Only',
       weight_limit_tons = null, overage_fee_cents = 0, active = true,
       description = 'Clean brush, limbs, leaves and untreated natural wood only. Includes 3.5 cubic yards of clean brush; additional volume is $18 per cubic yard.'
 where category = 'roll_off_green';

-- ---------- Heavy materials roll-off (new, bookable online) ----------
insert into dumpster_types
  (name, service, category, pricing_mode, size_yards, description, base_price_cents, deposit_cents,
   rental_days_included, extra_day_fee_cents, weight_limit_tons, overage_fee_cents,
   equipment_pool, uses_inventory, price_note, sort_order, active)
select '14 Yard Roll-Off — Heavy Materials', 'dumpster', 'roll_off_heavy', 'duration_tiers', 14,
       'Concrete, brick, block, dirt, soil, rock, gravel, ceramic or porcelain tile, roofing shingles, drywall, sheetrock, heavy timber. Includes 1,000 lb; additional weight $135 per 1,000 lb.',
       33900, 0, 7, 1500, 0.5, 27000, '14yd-rolloff', true, 'Starting at', 3, true
where not exists (select 1 from dumpster_types where category = 'roll_off_heavy');

-- ---------- same day tiers for all three ----------
insert into duration_price_tiers (type_id, days, price_cents, label, sort_order)
select t.id, v.days, v.price_cents, v.label, v.sort_order
from dumpster_types t
join (values
  (1, 33900, '1 Day', 1),
  (3, 36900, '3 Days', 2),
  (7, 41900, '7 Days - Most Popular', 3),
  (14, 53900, '14 Days', 4),
  (28, 73900, '28 Days', 5)
) as v(days, price_cents, label, sort_order) on true
where t.category in ('roll_off_standard', 'roll_off_heavy', 'roll_off_green')
on conflict (type_id, days) do update set price_cents = excluded.price_cents;

update dumpster_types set base_price_cents = 33900
 where category in ('roll_off_standard', 'roll_off_heavy', 'roll_off_green');

-- ---------- yard waste load sizes (editable under Prices & add-ons) ----------
insert into addon_items (name, category, price_cents, active, sort_order)
select v.name, 'brush_load', v.price_cents, true, v.sort_order
from (values
  ('1/2 load (7 cubic yards)', 6300, 101),
  ('3/4 load (10.5 cubic yards)', 12600, 102),
  ('Full load (14 cubic yards)', 18900, 103)
) as v(name, price_cents, sort_order)
where not exists (select 1 from addon_items a where a.category = 'brush_load' and a.name = v.name);
