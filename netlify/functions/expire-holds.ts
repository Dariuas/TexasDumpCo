import type { Config } from "@netlify/functions";
import { supabaseAdmin } from "./_shared/supabase";

// Scheduled: release inventory holds from abandoned pending bookings so their
// dates free up again. Runs every 15 minutes.
export default async () => {
  const { data, error } = await supabaseAdmin().rpc("expire_stale_holds");
  if (error) {
    console.error("[expire-holds]", error.message);
    return new Response("error", { status: 500 });
  }
  console.log(`[expire-holds] canceled ${data} stale pending bookings`);
  return new Response("ok");
};

export const config: Config = { schedule: "*/15 * * * *" };
