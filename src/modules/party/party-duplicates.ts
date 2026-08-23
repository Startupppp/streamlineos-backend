/**
 * Deciding whether two party records are the same organisation.
 *
 * The asymmetry drives every number here: a missed duplicate leaves two rows a
 * human can merge later, while a false merge fuses two customers' histories and
 * is only undone by someone noticing. So the bar for merging without asking is
 * deliberately high, identity evidence is required rather than a matching name,
 * and a contradiction anywhere blocks the merge outright regardless of score.
 *
 * Pure, so the weighting can be measured against a dataset rather than argued
 * about.
 */

export interface PartyFingerprint {
  readonly partyId: string;
  readonly name: string;
  readonly legalName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly taxNumber?: string | null;
  readonly website?: string | null;
}

export type MergeVerdict = "auto-merge" | "review" | "distinct";

export interface DuplicateAssessment {
  readonly score: number;
  readonly verdict: MergeVerdict;
  /** Which comparisons contributed, for the audit record and the review queue. */
  readonly signals: readonly string[];
  /** Contradictions. Any one of these prevents an automatic merge. */
  readonly blockers: readonly string[];
}

export const AUTO_MERGE_THRESHOLD = 0.85;
export const REVIEW_THRESHOLD = 0.45;

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

interface Weighted {
  readonly signal: string;
  readonly weight: number;
}

export function assessDuplicate(
  left: PartyFingerprint,
  right: PartyFingerprint,
): DuplicateAssessment {
  const matched: Weighted[] = [];
  const blockers: string[] = [];

  const bothHave = (a: string, b: string): boolean => a.length > 0 && b.length > 0;

  const tax = [normaliseTaxNumber(left.taxNumber), normaliseTaxNumber(right.taxNumber)] as const;
  if (bothHave(tax[0], tax[1])) {
    // A registration number is the strongest identity a business has, and two
    // different ones are proof these are different entities.
    if (tax[0] === tax[1]) matched.push({ signal: "tax-number", weight: 0.65 });
    else blockers.push("different tax numbers");
  }

  const email = [normaliseEmail(left.email), normaliseEmail(right.email)] as const;
  if (bothHave(email[0], email[1]) && email[0] === email[1])
    matched.push({ signal: "email", weight: 0.55 });

  const domain = [emailDomain(left.email), emailDomain(right.email)] as const;
  if (bothHave(domain[0], domain[1]) && domain[0] === domain[1] && email[0] !== email[1])
    matched.push({ signal: "email-domain", weight: 0.12 });

  const phone = [normalisePhone(left.phone), normalisePhone(right.phone)] as const;
  if (bothHave(phone[0], phone[1]) && phone[0] === phone[1])
    matched.push({ signal: "phone", weight: 0.35 });

  const host = [normaliseHost(left.website), normaliseHost(right.website)] as const;
  if (bothHave(host[0], host[1]) && host[0] === host[1])
    matched.push({ signal: "website", weight: 0.2 });

  const names = [normaliseName(left.name), normaliseName(right.name)] as const;
  const legalNames = [
    normaliseName(left.legalName) || names[0],
    normaliseName(right.legalName) || names[1],
  ] as const;

  const similarity = Math.max(
    nameSimilarity(names[0], names[1]),
    nameSimilarity(legalNames[0], legalNames[1]),
  );

  if (similarity === 1) matched.push({ signal: "name-exact", weight: 0.3 });
  else if (similarity >= 0.8) matched.push({ signal: "name-close", weight: 0.2 });
  else if (similarity >= 0.6) matched.push({ signal: "name-similar", weight: 0.1 });

  const score = Math.min(
    1,
    matched.reduce((total, entry) => total + entry.weight, 0),
  );
  const signals = matched.map((entry) => entry.signal);

  /**
   * A name is not identity. Any number of unrelated businesses trade under
   * similar names, so merging without at least one hard identifier — a tax
   * number, an address, a phone line — is exactly the false merge this is
   * weighted to avoid.
   */
  const identifying = signals.some((signal) =>
    ["tax-number", "email", "phone"].includes(signal),
  );

  const verdict: MergeVerdict =
    blockers.length === 0 && score >= AUTO_MERGE_THRESHOLD && identifying
      ? "auto-merge"
      : score >= REVIEW_THRESHOLD
        ? "review"
        : "distinct";

  return { score: Number(score.toFixed(4)), verdict, signals, blockers };
}
