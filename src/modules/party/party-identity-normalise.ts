/**
 * How a value is compared, separately from what a match is worth.
 *
 * Every function here answers "are these two spellings the same thing" and
 * nothing else: no weights, no thresholds, no verdict. That line is worth a
 * file because the two halves change for different reasons — a normaliser
 * changes when the world writes a value a new way, a weight changes when the
 * scoring is measured against real data — and because the normalisations are
 * mirrored in SQL by `crm/import/import-lookups.ts`, which has to be read
 * against these definitions and nothing else.
 *
 * `party-duplicates` re-exports all of this, so callers and doc comments that
 * already name it as the home of these functions stay right.
 */

/** Legal-form suffixes carry no identity: "Acme Ltd" and "Acme Inc" may be one company. */
const COMPANY_SUFFIXES = new Set([
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "llc",
  "llp",
  "plc",
  "pvt",
  "private",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "bv",
  "sa",
  "ag",
  "pte",
]);

export function normaliseName(value: string | null | undefined): string {
  if (!value) return "";
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !COMPANY_SUFFIXES.has(word));
  return words.join(" ");
}

export function normaliseEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function emailDomain(value: string | null | undefined): string {
  const at = normaliseEmail(value).lastIndexOf("@");
  return at > 0 ? normaliseEmail(value).slice(at + 1) : "";
}

/**
 * Last ten digits.
 *
 * The same line is written with and without a country code, with spaces, with a
 * leading zero. Comparing the tail is what makes those match without a
 * phone-number library.
 */
export function normalisePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normaliseTaxNumber(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function normaliseHost(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutScheme = raw.replace(/^[a-z]+:\/\//, "");
  const host = withoutScheme.split("/")[0] ?? "";
  return host.replace(/^www\./, "");
}

/** Dice coefficient over bigrams: catches a typo or a word order change. */
export function nameSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const bigrams = (value: string): string[] => {
    const padded = ` ${value} `;
    return Array.from({ length: padded.length - 1 }, (_, i) => padded.slice(i, i + 2));
  };

  const a = bigrams(left);
  const b = bigrams(right);
  const pool = new Map<string, number>();
  for (const gram of a) pool.set(gram, (pool.get(gram) ?? 0) + 1);

  let shared = 0;
  for (const gram of b) {
    const count = pool.get(gram) ?? 0;
    if (count > 0) {
      shared += 1;
      pool.set(gram, count - 1);
    }
  }

  return (2 * shared) / (a.length + b.length);
}
