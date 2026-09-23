import { supabaseAdmin } from "./supabase";

export interface AuthedUser {
  id: string;
  email: string | null;
  role: "admin" | "staff" | "customer";
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

// Verify a Supabase access token and resolve the user's role from `profiles`.
export async function getUser(req: Request): Promise<AuthedUser | null> {
  const token = bearer(req);
  if (!token) return null;

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("user_id", data.user.id)
    .maybeSingle();

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    role: (profile?.role as AuthedUser["role"]) ?? "customer",
  };
}

// Throwable guard for admin/staff-only endpoints.
export async function requireStaff(req: Request): Promise<AuthedUser> {
  const user = await getUser(req);
  if (!user) throw new AuthError("Not authenticated", 401);
  if (user.role !== "admin" && user.role !== "staff") {
    throw new AuthError("Staff access required", 403);
  }
  return user;
}

export async function requireAdmin(req: Request): Promise<AuthedUser> {
  const user = await getUser(req);
  if (!user) throw new AuthError("Not authenticated", 401);
  if (user.role !== "admin") throw new AuthError("Admin access required", 403);
  return user;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
