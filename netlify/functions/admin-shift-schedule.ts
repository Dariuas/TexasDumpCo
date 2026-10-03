import { adminHandler } from "./_shared/admin";
import { json, badRequest, readJson } from "./_shared/response";
import { supabaseAdmin } from "./_shared/supabase";
import { loadSettings } from "./_shared/settings";
import { audit } from "./_shared/audit";

const SHIFT_REASON = "Owner on shift (auto)";
const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

export interface ShiftConfig {
  enabled: boolean;
  anchor_date: string; // first day of any "on" block
  on_days: number;
  off_days: number;
}

// Expand a repeating on/off pattern into contiguous on-shift blocks within [from, to].
export function shiftBlocks(cfg: ShiftConfig, from: string, to: string): Array<[string, string]> {
  const cycle = cfg.on_days + cfg.off_days;
  const anchor = parse(cfg.anchor_date).getTime();
  const blocks: Array<[string, string]> = [];
  let start: string | null = null;
  let prev = "";
  for (let t = parse(from).getTime(); t <= parse(to).getTime(); t += DAY_MS) {
    const pos = (((Math.round((t - anchor) / DAY_MS)) % cycle) + cycle) % cycle;
    const day = iso(new Date(t));
    if (pos < cfg.on_days) {
      if (start === null) start = day;
      prev = day;
    } else if (start !== null) {
      blocks.push([start, prev]);
      start = null;
    }
  }
  if (start !== null) blocks.push([start, prev]);
  return blocks;
}

// Owner is a firefighter on a rotating shift. Shift days become auto-managed
// blackouts (so every availability path already honors them); the owner can
// still add one-off blackouts, which this never touches.
export default adminHandler("admin", async (req, user) => {
  const db = supabaseAdmin();

  if (req.method === "GET") {
    const s = await loadSettings();
    return json({ shift: s["owner_shift"] ?? null });
  }
  if (req.method !== "POST") return badRequest("GET or POST");

  const body = await readJson<Partial<ShiftConfig> & { horizon_days?: number; from_date?: string }>(req);
  const cfg: ShiftConfig = {
    enabled: body.enabled !== false,
    anchor_date: String(body.anchor_date || ""),
    on_days: Math.floor(Number(body.on_days)),
    off_days: Math.floor(Number(body.off_days)),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.anchor_date)) return badRequest("anchor_date must be YYYY-MM-DD");
  if (!(cfg.on_days >= 1) || !(cfg.off_days >= 0)) return badRequest("on_days >= 1 and off_days >= 0 required");
  const horizon = Math.min(Math.max(Math.floor(Number(body.horizon_days)) || 365, 30), 730);

  const today = iso(new Date());
  // Rebuild auto blocks only from this date forward. Earlier blocks (and any hand edits
  // to them), past history and manual blackouts are left alone.
  const fromDate = body.from_date && /^\d{4}-\d{2}-\d{2}$/.test(body.from_date) && body.from_date > today ? body.from_date : today;
  const del = await db.from("blackouts").delete().eq("reason", SHIFT_REASON).gte("end_at", `${fromDate}T00:00:00Z`);
  if (del.error) throw new Error(del.error.message);

  let created = 0;
  if (cfg.enabled) {
    const end = iso(new Date(parse(fromDate).getTime() + horizon * DAY_MS));
    const rows = shiftBlocks(cfg, fromDate, end).map(([a, b]) => ({
      start_at: `${a}T00:00:00Z`, end_at: `${b}T23:59:59Z`, scope: "all", type_id: null, reason: SHIFT_REASON,
    }));
    if (rows.length) {
      const ins = await db.from("blackouts").insert(rows);
      if (ins.error) throw new Error(ins.error.message);
    }
    created = rows.length;
  }

  const up = await db.from("settings").upsert({ key: "owner_shift", value: cfg });
  if (up.error) throw new Error(up.error.message);
  await audit({ actor: user.email!, action: "shift.regenerate", entity: "settings", detail: { ...cfg, created } });
  return json({ ok: true, created });
});
