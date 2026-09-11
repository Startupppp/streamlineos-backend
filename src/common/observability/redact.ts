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
export const SENSITIVE_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "accesskey",
  "credential",
  "privatekey",
  "sessionid",
  "aadhaar",
  "pannumber",
  "pancard",
  "cardnumber",
  "accountnumber",
  "connectionstring",
  // Tenant data rather than a credential, and the distinction does not matter to
  // a log aggregator: a mailbox address, a phone number, an AI prompt, a message
  // subject or a document's filename is a customer's content, and the whole point
  // of a log line is that a much wider group can read it. Context (which org,
  // which actor id, which route) is what an operator needs; the content is not.
  "emailaddress",
  "phonenumber",
  "mobilenumber",
  "recipient",
  "prompt",
  "filename",
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
export const SENSITIVE_EXACT = new Set([
  "pan",
  "otp",
  "cvv",
  "ssn",
  "dsn",
  "pin",
  "jwt",
  "bearer",
  "query",
  // Drizzle's `DrizzleQueryError` carries the bind values of the failing
  // statement on `params` — every value the statement was about to write.
  "params",
  "driverdetail",
  // Tenant data. `to`, `cc` and `bcc` are only ever recipients in log metadata;
  // `subject` is a message's own free text.
  "email",
  "emails",
  "phone",
  "to",
  "cc",
  "bcc",
  "subject",
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitive(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SENSITIVE_EXACT.has(normalised)) return true;
  return SENSITIVE_SUBSTRINGS.some((needle) => normalised.includes(needle));
}

export function redactAttributes(
  attrs: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isSensitive(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = typeof value === "string" ? truncateForLog(value) : value;
  }
  return out;
}

/**
 * Drizzle builds `DrizzleQueryError`'s message as
 * `Failed query: <sql>\nparams: <bind values>`, so the values the statement was
 * about to write are carried in the message itself — not on a property a key
 * check could reach. That message is then re-emitted by every generic handler:
 * `AllExceptionsFilter`, `forEachOrg`'s per-organisation catch, the after-commit
 * drain, `logSideEffectFailure`, and any `logger.error(\`… ${err.message}\`)`.
 * Withholding the `query` key while the same SQL and every bind value ride along
 * in the message would be redaction in name only.
 *
 * Scoped to the exact shape rather than any line containing "params:", so a
 * message that merely mentions parameters is left readable.
 */
const DRIZZLE_QUERY_ERROR = /Failed query:/;
const BIND_PARAMS_LINE = /(\bparams:)[^\n]*/g;

export function scrubBindParameters(value: string): string {
  if (!DRIZZLE_QUERY_ERROR.test(value)) return value;
  return value.replace(BIND_PARAMS_LINE, `$1 ${REDACTED}`);
}

/**
 * The single chokepoint every string passes through on its way to a log line:
 * the message, each string inside `meta`, an error's message and its stack.
 * Scrubbing here rather than at each call site is what makes the guarantee hold
 * for call sites that have not been written yet.
 */
export function truncateForLog(value: string): string {
  const scrubbed = scrubBindParameters(value);
  if (scrubbed.length <= MAX_STRING) return scrubbed;
  return `${scrubbed.slice(0, MAX_STRING)}… [truncated ${scrubbed.length - MAX_STRING} chars]`;
}

function describeError(error: Error): Record<string, unknown> {
  const record = error as Error & Record<string, unknown>;
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
