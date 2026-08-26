/**
 * Makes an arbitrary value safe to write to a log or send to an error tracker.
 *
 * Logs are the easiest place to leak a credential or a customer's personal data,
 * and the leak is silent — nothing fails, the value is simply sitting in a log
 * aggregator that a much wider group can read. So this is allow-by-default on
 * shape but deny-by-default on anything whose key suggests it carries a secret.
 */

const MAX_DEPTH = 4;
const MAX_STRING = 1_000;
const MAX_ARRAY = 100;
const MAX_KEYS = 60;

const REDACTED = "[redacted]";

/** Matched against the key with punctuation and casing removed. */
const SENSITIVE_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "credential",
  "privatekey",
  "sessionid",
  "aadhaar",
  "pannumber",
  "pancard",
  "cardnumber",
  "accountnumber",
  "connectionstring",
] as const;

/**
 * Short keys that would produce false positives as substrings, plus the two
 * carriers of database diagnostics.
 *
 * `driverDetail` holds a Postgres error's `detail`, `hint` and `query`. Those
 * routinely quote the offending row — a unique-violation sets `detail` to
 * `Key (email)=(ada@example.com) already exists.` — so the whole subtree is
 * withheld while the safe diagnostics (table, column, SQLSTATE) stay readable.
 */
const SENSITIVE_EXACT = new Set([
  "pan",
  "otp",
  "cvv",
  "ssn",
  "dsn",
  "pin",
  "query",
  "driverdetail",
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitive(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SENSITIVE_EXACT.has(normalised)) return true;
  return SENSITIVE_SUBSTRINGS.some((needle) => normalised.includes(needle));
}

export function truncateForLog(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}… [truncated ${value.length - MAX_STRING} chars]`;
}

function describeError(error: Error): Record<string, unknown> {
  const record = error as unknown as Record<string, unknown>;
  const code = record["code"];
  return {
    name: error.name,
    message: truncateForLog(error.message),
    stack: typeof error.stack === "string" ? truncateForLog(error.stack) : undefined,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  };
}

export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateForLog(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return walk(describeError(value), depth, seen);

  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[circular]";
  if (depth > MAX_DEPTH) return "[depth-limit]";
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_ARRAY).map((entry) => walk(entry, depth + 1, seen));
      if (value.length > MAX_ARRAY) kept.push(`… ${value.length - MAX_ARRAY} more`);
      return kept;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, MAX_KEYS)) {
      out[key] = isSensitive(key) ? REDACTED : walk(entry, depth + 1, seen);
    }
    if (entries.length > MAX_KEYS) {
      out["…"] = `${entries.length - MAX_KEYS} more keys`;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
