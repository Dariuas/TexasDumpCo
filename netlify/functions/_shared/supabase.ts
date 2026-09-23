import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Service-role client — bypasses RLS. Use ONLY on the server for trusted
// operations. Never expose the service role key to the browser.
let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

// A client bound to a caller's JWT — used to identify the logged-in user
// while still honoring RLS for reads.
export function supabaseForToken(accessToken: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
