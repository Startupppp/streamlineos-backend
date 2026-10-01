export type Truth = boolean | null;

export class UnsupportedQuery extends Error {
  constructor(detail: string) {
    super(`world-db: unsupported ${detail}`);
    this.name = "UnsupportedQuery";
  }
}

export class Interval {
  constructor(readonly milliseconds: number) {}
}

const INTERVAL_UNITS: Readonly<Record<string, number>> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};
const INTERVAL_TEXT = /^\s*(-?\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?\s*$/i;
const TO_CHAR_ISO_MICROS = 'YYYY-MM-DD"T"HH24:MI:SS.US';

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  return value;
}

export function compare(left: unknown, right: unknown): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  let a = comparable(left);
  let b = comparable(right);
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b))) b = Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && !Number.isNaN(Number(a))) a = Number(a);
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : 1;
  if (typeof a !== typeof b) return 1;
  throw new UnsupportedQuery(`comparison of ${typeof a} values`);
}

export function likeMatch(value: unknown, pattern: unknown, caseless: boolean): Truth {
  if (value === null || value === undefined || pattern === null || pattern === undefined) return null;
  if (typeof value !== "string" || typeof pattern !== "string") throw new UnsupportedQuery("like over a non-string");
  const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escape(pattern[index]);
    } else if (char === "%") source += "[\\s\\S]*";
    else if (char === "_") source += "[\\s\\S]";
    else source += escape(char);
  }
  return new RegExp(`^${source}$`, caseless ? "i" : "").test(value);
}

export function andOf(values: readonly Truth[]): Truth {
  if (values.includes(false)) return false;
  if (values.includes(null)) return null;
  return true;
}

export function orOf(values: readonly Truth[]): Truth {
  if (values.includes(true)) return true;
  if (values.includes(null)) return null;
  return false;
}

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

export function castTo(value: unknown, type: string): unknown {
  if (isAbsent(value)) return null;
  if (type === "interval") {
    const parsed = typeof value === "string" ? INTERVAL_TEXT.exec(value) : null;
    if (parsed === null) throw new UnsupportedQuery(`interval literal ${JSON.stringify(value)}`);
    return new Interval(Number(parsed[1]) * INTERVAL_UNITS[parsed[2].toLowerCase()]);
  }
  if (type === "int" || type === "integer") {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isInteger(number)) throw new UnsupportedQuery(`cast of ${JSON.stringify(value)} to ${type}`);
    return number;
  }
  if (type === "text") {
    if (typeof value !== "string" && typeof value !== "number") throw new UnsupportedQuery(`cast of a ${typeof value} to text`);
    return String(value);
  }
  throw new UnsupportedQuery(`cast to ${type}`);
}

export function combine(operator: string, left: unknown, right: unknown): unknown {
  if (isAbsent(left) || isAbsent(right)) return null;
  if (operator === "||") {
    if ((typeof left !== "string" && typeof left !== "number") || (typeof right !== "string" && typeof right !== "number"))
      throw new UnsupportedQuery("concatenation of a non-scalar");
    return `${left}${right}`;
  }
  const sign = operator === "-" ? -1 : 1;
  if (typeof left === "number" && typeof right === "number") return left + sign * right;
  if (left instanceof Date && right instanceof Interval) return new Date(left.getTime() + sign * right.milliseconds);
  throw new UnsupportedQuery(`arithmetic ${operator} over ${typeof left} and ${typeof right}`);
}

export function toChar(value: unknown, zone: unknown, format: unknown): string | null {
  if (zone !== "UTC" || format !== TO_CHAR_ISO_MICROS) throw new UnsupportedQuery(`to_char at zone ${String(zone)} with format ${String(format)}`);
  if (isAbsent(value)) return null;
  if (!(value instanceof Date)) throw new UnsupportedQuery("to_char over a non-timestamp");
  return `${value.toISOString().slice(0, 23)}000`;
}
