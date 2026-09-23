import { AuthedUser, AuthError, requireAdmin, requireStaff } from "./auth";
import { json, serverError } from "./response";

type AdminFn = (req: Request, user: AuthedUser) => Promise<Response>;

// Wraps an admin/staff endpoint: enforces role, maps AuthError -> status,
// and keeps error handling out of every handler body.
export function adminHandler(role: "admin" | "staff", fn: AdminFn) {
  return async (req: Request): Promise<Response> => {
    let user: AuthedUser;
    try {
      user = role === "admin" ? await requireAdmin(req) : await requireStaff(req);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status);
      return serverError("Auth check failed");
    }
    try {
      return await fn(req, user);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      console.error("[admin function error]", err);
      return serverError(message);
    }
  };
}
