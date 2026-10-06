import { supabaseAdmin } from "./supabase";

export interface ContractorRow {
  id: string;
  contractor_number: string | null;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  phone_digits: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  tax_exempt: boolean;
  tax_exempt_cert: string | null;
}

// Digits only, US numbers without the leading country code, so
// "(512) 337-4340", "512.337.4340" and "+1 512 337 4340" all match.
export function phoneDigits(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

// No 0/O/1/I so a number read over the phone is unambiguous.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeNumber(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `TXC-${s}`;
}

const COLS = "id,contractor_number,company_name,contact_name,email,phone,phone_digits,status,tax_exempt,tax_exempt_cert";

// Find a contractor by number, email or phone (first match wins in that order).
export async function findContractor(q: { number?: string | null; email?: string | null; phone?: string | null }): Promise<ContractorRow | null> {
  const db = supabaseAdmin();
  const number = q.number?.trim().toUpperCase();
  if (number) {
    const { data } = await db.from("contractors").select(COLS).eq("contractor_number", number).maybeSingle();
    if (data) return data as ContractorRow;
  }
  const email = q.email?.trim().toLowerCase();
  if (email) {
    const { data } = await db.from("contractors").select(COLS).ilike("email", email.replace(/[\\%_]/g, (m) => `\\${m}`)).limit(1).maybeSingle();
    if (data) return data as ContractorRow;
  }
  const digits = phoneDigits(q.phone);
  if (digits.length >= 10) {
    const { data } = await db.from("contractors").select(COLS).eq("phone_digits", digits).order("created_at").limit(1).maybeSingle();
    if (data) return data as ContractorRow;
  }
  return null;
}

// A booking or request may use a contractor's number only when the number's account
// also matches the email OR phone given, so a number alone can't be borrowed.
export function matchesContact(c: ContractorRow, email?: string | null, phone?: string | null): boolean {
  const e = email?.trim().toLowerCase();
  const d = phoneDigits(phone);
  return (!!e && c.email.toLowerCase() === e) || (d.length >= 10 && c.phone_digits === d);
}

// Give an approved contractor a number if it doesn't have one yet (retry on the
// rare collision with the unique index). Returns the number.
export async function ensureNumber(id: string): Promise<string> {
  const db = supabaseAdmin();
  const { data: cur } = await db.from("contractors").select("contractor_number").eq("id", id).maybeSingle();
  if (cur?.contractor_number) return cur.contractor_number;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db.from("contractors").update({ contractor_number: makeNumber() })
      .eq("id", id).is("contractor_number", null).select("contractor_number").maybeSingle();
    if (!error && data?.contractor_number) return data.contractor_number;
    if (!error) {
      // Someone else set it between our read and write.
      const { data: again } = await db.from("contractors").select("contractor_number").eq("id", id).maybeSingle();
      if (again?.contractor_number) return again.contractor_number;
    } else if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error("Could not generate a contractor number, please try again");
}

// A contractor box was ticked but no approved account matched: make sure there is
// an application in the queue for these details (never duplicates by email/phone).
export async function ensureApplication(a: { company_name?: string | null; contact_name: string; email: string; phone: string; license_info?: string | null }): Promise<ContractorRow> {
  const existing = await findContractor({ email: a.email, phone: a.phone });
  if (existing) return existing;
  const { data, error } = await supabaseAdmin().from("contractors").insert({
    contractor_number: null,
    company_name: a.company_name?.trim() || a.contact_name.trim(),
    contact_name: a.contact_name.trim(),
    email: a.email.trim().toLowerCase(),
    phone: a.phone.trim(),
    phone_digits: phoneDigits(a.phone),
    license_info: a.license_info?.trim() || null,
  }).select(COLS).single();
  if (error) {
    // Raced with another request using the same email: return that row.
    const again = await findContractor({ email: a.email, phone: a.phone });
    if (again) return again;
    throw new Error(error.message);
  }
  return data as ContractorRow;
}
