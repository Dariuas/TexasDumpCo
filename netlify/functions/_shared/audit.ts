import { supabaseAdmin } from "./supabase";

// Fire-and-forget audit trail for admin/money actions.
export async function audit(entry: {
  actor: string;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    await supabaseAdmin().from("audit_log").insert({
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity ?? null,
      entity_id: entry.entityId ?? null,
      detail: entry.detail ?? null,
    });
  } catch (err) {
    console.error("[audit] failed:", (err as Error).message);
  }
}
