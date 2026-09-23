-- ============================================================
--  Seed data — safe placeholder pricing the client edits in-app.
--  Money is in cents. Re-runnable (idempotent on natural keys).
-- ============================================================

-- ---------- business settings ----------
insert into settings (key, value) values
  ('company_name',     '"Texas Dumpster Co"'),
  ('company_phone',    '"(512) 337-4340"'),
  ('company_email',    '"bookings@texasdumpco.com"'),
  ('deposit_percent',  '25'),          -- used when a type has deposit_cents = 0
  ('tax_rate_bps',     '825'),         -- 8.25% in basis points
  ('lead_time_days',   '1'),           -- earliest booking = today + N days
  ('per_day_cap',      '0'),           -- 0 = only limited by inventory
  ('cash_accepted',    'false'),       -- master switch for the cash option
  ('booking_window_days', '120'),      -- how far out customers may book
  ('time_windows',     '["Morning (8a-12p)","Afternoon (12p-5p)","Anytime"]'),
  ('alert_email',      '"bookings@texasdumpco.com"')
on conflict (key) do nothing;

-- ---------- dumpster types (pricing placeholders) ----------
insert into dumpster_types
  (name, service, size_yards, description, base_price_cents, deposit_cents,
   rental_days_included, extra_day_fee_cents, weight_limit_tons, overage_fee_cents, sort_order)
values
  ('10 Yard Roll-Off',  'dumpster', 10, 'Great for small cleanouts, bathroom remodels, and yard debris.', 32500, 0, 7, 1500, 2.0, 8500, 1),
  ('15 Yard Roll-Off',  'dumpster', 15, 'Mid-size projects, flooring, and medium renovations.',           38500, 0, 7, 1500, 3.0, 8500, 2),
  ('20 Yard Roll-Off',  'dumpster', 20, 'Large remodels, roofing, and big cleanouts.',                     44500, 0, 7, 1500, 4.0, 8500, 3),
  ('30 Yard Roll-Off',  'dumpster', 30, 'Whole-home cleanouts, construction, and commercial jobs.',         52500, 0, 10, 1500, 5.0, 8500, 4)
on conflict do nothing;

insert into dumpster_types
  (name, service, description, base_price_cents, deposit_cents, sort_order)
values
  ('Junk Hauling — Single Item', 'junk', 'We haul away one large item (appliance, furniture, mattress).', 9500, 0, 10),
  ('Junk Hauling — 1/4 Load',    'junk', 'Small crew pickup, about a quarter truck load.',                18500, 0, 11),
  ('Junk Hauling — 1/2 Load',    'junk', 'Half truck load — garage or room cleanout.',                    32500, 0, 12),
  ('Junk Hauling — Full Load',   'junk', 'Full truck — whole-home or estate cleanout.',                   55000, 0, 13)
on conflict do nothing;

-- ---------- inventory units (one starter unit per dumpster type) ----------
insert into inventory_units (type_id, label, status)
select t.id, t.name || ' #1', 'available'
from dumpster_types t
where t.service = 'dumpster'
  and not exists (select 1 from inventory_units u where u.type_id = t.id);

-- ---------- agreement template v1 ----------
insert into agreement_templates (version, title, body_html, active)
select 1, 'Rental Agreement',
$html$
<h3>Texas Dumpster Co — Rental Agreement</h3>
<p>By signing below you agree to the following terms:</p>
<ul>
  <li><strong>Placement:</strong> You are responsible for providing a clear, legal, and accessible drop-off location. Damage to driveways, sprinklers, or private surfaces is not the responsibility of Texas Dumpster Co.</li>
  <li><strong>Prohibited items:</strong> No hazardous waste, tires, batteries, paint, chemicals, or wet paint. Prohibited items may incur additional fees.</li>
  <li><strong>Weight limits:</strong> Loads over the included tonnage are billed at the posted overage rate per ton.</li>
  <li><strong>Rental period &amp; extensions:</strong> Additional days beyond the included period are billed at the posted daily rate.</li>
  <li><strong>Cancellations &amp; refunds:</strong> Cancellations made before delivery are eligible for a refund less any processing fees. Deposits may be non-refundable within 24 hours of the scheduled delivery.</li>
</ul>
<p>You certify that you are authorized to place a dumpster at the delivery address provided.</p>
$html$,
  true
where not exists (select 1 from agreement_templates where version = 1);
