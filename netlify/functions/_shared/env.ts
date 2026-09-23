// Typed access to environment variables with clear failures.

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const IS_STRIPE_LIVE = (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");

// The public site origin, used to build Stripe redirect URLs.
export function siteUrl(): string {
  return (
    process.env.SITE_URL ||
    process.env.URL || // Netlify provides this at build/runtime
    "http://localhost:8888"
  ).replace(/\/$/, "");
}
