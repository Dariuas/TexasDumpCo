import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env, optionalEnv } from "./env";

// Stateless email-ownership challenge for agreement signing. The server emails a
// 6-digit code and hands the browser an HMAC token binding (email, code, expiry);
// nothing is stored. On submit we recompute the HMAC from what the customer typed.
const TTL_MS = 15 * 60_000;

function key(): string {
  return optionalEnv("AGREEMENT_SECRET") ?? env("SUPABASE_SERVICE_ROLE_KEY");
}
function mac(email: string, code: string, expires: number): string {
  return createHmac("sha256", key()).update(`${email.trim().toLowerCase()}|${code}|${expires}`).digest("hex");
}

export function makeChallenge(email: string): { code: string; token: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = Date.now() + TTL_MS;
  return { code, token: `${expires}.${mac(email, code, expires)}` };
}

export function checkChallenge(email: string, code: string, token: string): boolean {
  const [expStr, sig] = String(token || "").split(".");
  const expires = Number(expStr);
  if (!sig || !Number.isFinite(expires) || expires < Date.now()) return false;
  const want = Buffer.from(mac(email, String(code || "").trim(), expires), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// Tamper-evident fingerprint of exactly what the customer saw and signed.
export function agreementHash(parts: { version: number; lang: string; html: string; name: string; email: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.version, parts.lang, parts.html, parts.name.trim().toLowerCase(), parts.email.trim().toLowerCase()]))
    .digest("hex");
}
