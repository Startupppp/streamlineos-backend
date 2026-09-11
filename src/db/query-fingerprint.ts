/**
 * Slow-query fingerprints that carry no bind values.
 *
 * §5.1 box 9 asks for fingerprints and per-query call counts *without* logging
 * sensitive bind values, and those two requirements pull against each other: the
 * obvious key is the SQL text, and SQL text is where a literal hides. So the
 * shape is normalised before it is ever stored — every string literal, numeric
 * literal and `$n` placeholder collapses to `?` — and only the normalised shape
 * and its hash are kept. Nothing that reaches a snapshot or a log has ever held
 * a value a tenant supplied.
 *
 * The driver parameterises, so the common case already arrives as `$1`; the
 * literal stripping is for the raw `sql\`\`` fragments that interpolate a
 * constant, and for anything a future call site inlines by mistake.
 */

const LINE_COMMENT = /--[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const DOLLAR_QUOTED = /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g;
const SINGLE_QUOTED = /'(?:[^']|'')*'/g;
const DOUBLE_QUOTED_LITERAL = /\bE'(?:[^']|'')*'/gi;
const PLACEHOLDER = /\$\d+/g;
const NUMBER_LITERAL = /\b\d+(?:\.\d+)?\b/g;
const IN_LIST = /\((?:\s*\?\s*,)+\s*\?\s*\)/g;
const WHITESPACE = /\s+/g;

export const FINGERPRINT_SHAPE_MAX = 160;

export function normalizeQueryShape(queryText: string): string {
  return queryText
    .replace(BLOCK_COMMENT, " ")
    .replace(LINE_COMMENT, " ")
    .replace(DOLLAR_QUOTED, "?")
    .replace(DOUBLE_QUOTED_LITERAL, "?")
    .replace(SINGLE_QUOTED, "?")
    .replace(PLACEHOLDER, "?")
    .replace(NUMBER_LITERAL, "?")
    .replace(IN_LIST, "(?)")
    .replace(WHITESPACE, " ")
    .trim();
}

/** FNV-1a. Stable across processes, which a `Math.random`-salted hash would not be. */
export function hashShape(shape: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < shape.length; index++) {
    hash ^= shape.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface QueryFingerprint {
  id: string;
  shape: string;
}

export function fingerprintQuery(queryText: string): QueryFingerprint {
  const shape = normalizeQueryShape(queryText);
  return {
    id: hashShape(shape),
    shape: shape.length > FINGERPRINT_SHAPE_MAX ? `${shape.slice(0, FINGERPRINT_SHAPE_MAX)}…` : shape,
  };
}

/**
 * Postgres SQLSTATEs that mean the database made us wait or gave up, as opposed
 * to the statement being wrong. Counted by class so a lock storm is visible
 * without recording anything about the rows involved.
 */
export const CONTENTION_SQLSTATES: Record<string, "lockWait" | "deadlock" | "timeout"> = {
  "55P03": "lockWait",
  "40P01": "deadlock",
  "40001": "deadlock",
  "57014": "timeout",
};

export function classifyContention(error: unknown): "lockWait" | "deadlock" | "timeout" | null {
  if (error === null || typeof error !== "object") return null;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string") return null;
  return CONTENTION_SQLSTATES[code] ?? null;
}

/** postgres.js resolves to an array carrying `count`; drizzle may hand back a plain array. */
export function rowsReturnedOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    const rows: unknown = Reflect.get(value, "rows");
    if (Array.isArray(rows)) return rows.length;
    const count: unknown = Reflect.get(value, "count");
    if (typeof count === "number" && Number.isFinite(count)) return count;
  }
  return 0;
}
