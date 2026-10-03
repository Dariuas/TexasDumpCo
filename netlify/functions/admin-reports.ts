import { adminHandler } from "./_shared/admin";
import { json } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";

// Report data: bookings + revenue by month, by service, and by "where did you hear about us".
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (by delivery start date; defaults to the last 12 months)
export default adminHandler("staff", async (req) => {
  const url = new URL(req.url);
  const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ||
    new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin()
    .from("bookings")
    .select("start_date,status,service,amount_total_cents,amount_paid_cents,referral_source,contractor_id,dumpster_types(name)")
    .gte("start_date", from).lte("start_date", to)
    .neq("status", "canceled")
    .limit(10000);
  if (error) throw new Error(error.message);

  const bump = (m: Map<string, { count: number; revenue_cents: number }>, k: string, rev: number) => {
    const e = m.get(k) ?? { count: 0, revenue_cents: 0 };
    e.count += 1; e.revenue_cents += rev; m.set(k, e);
  };
  const month = new Map(), source = new Map(), type = new Map(), kind = new Map();
  for (const b of data ?? []) {
    const rev = b.amount_total_cents || 0;
    bump(month, b.start_date.slice(0, 7), rev);
    bump(source, b.referral_source || "Not asked / unknown", rev);
    bump(type, (b as any).dumpster_types?.name || b.service, rev);
    bump(kind, b.contractor_id ? "Contractor" : "Retail", rev);
  }
  const rows = (m: Map<string, { count: number; revenue_cents: number }>) =>
    [...m.entries()].map(([label, v]) => ({ label, ...v }));
  return json({
    from, to, total: (data ?? []).length,
    revenue_cents: (data ?? []).reduce((s, b) => s + (b.amount_total_cents || 0), 0),
    by_month: rows(month).sort((a, b) => a.label.localeCompare(b.label)),
    by_source: rows(source).sort((a, b) => b.count - a.count),
    by_type: rows(type).sort((a, b) => b.count - a.count),
    by_customer_kind: rows(kind),
  });
});
