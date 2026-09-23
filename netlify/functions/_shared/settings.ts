import { supabaseAdmin } from "./supabase";

export type Settings = Record<string, unknown>;

// Load all settings as a plain object. Values are stored as JSONB.
export async function loadSettings(): Promise<Settings> {
  const { data, error } = await supabaseAdmin().from("settings").select("key,value");
  if (error) throw new Error(error.message);
  const out: Settings = {};
  for (const row of data ?? []) out[row.key] = row.value;
  return out;
}

export function num(settings: Settings, key: string, fallback: number): number {
  const v = settings[key];
  return typeof v === "number" ? v : fallback;
}

export function bool(settings: Settings, key: string, fallback = false): boolean {
  const v = settings[key];
  return typeof v === "boolean" ? v : fallback;
}

export function str(settings: Settings, key: string, fallback = ""): string {
  const v = settings[key];
  return typeof v === "string" ? v : fallback;
}
