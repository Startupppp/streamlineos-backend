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
  /**
   * Every address this record is reachable at, from `party_identifiers`.
   *
   * The identity half of the comparison. It used to be the `email` and `phone`
   * columns compared as strings, which is why the pairs most worth merging were
   * the ones it could not see: two records for one person routinely disagree
   * about which column a number belongs in, and a customer reached on WhatsApp
   * had no comparable value at all.
   */
  readonly identifiers?: readonly PartyIdentity[];
  /**
   * The contact columns, where the caller has only those.
   *
   * An input into the identifier set, not a second way of matching: a CSV being
   * imported has columns and no rows in `party_identifiers` yet, and refusing to
   * score it would mean an import could not detect a duplicate against itself.
   * `identitiesOf` folds these in and everything downstream compares one set.
   */
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly taxNumber?: string | null;
  readonly website?: string | null;
}

/** One identifier as the scorer compares it: what kind, and what value. */
export interface PartyIdentity {
  readonly kind: string;
  readonly value: string;
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

/**
 * What a matching identifier is worth, per group.
 *
 * The same numbers the column comparison carried, because the evidence has not
 * changed — an address two records share is the same evidence whether it was
 * read from a column or from `party_identifiers`.
 */
const IDENTITY_WEIGHTS: readonly (readonly [string, number])[] = [
  ["email", 0.55],
  ["phone", 0.35],
  ["handle", 0.3],
];

/**
 * Which identifiers are the same evidence.
 *
 * `whatsapp` and `phone` are one telephone line reached two ways, and a
 * duplicate pair is precisely where two records disagree about which of the two
 * columns it belonged in — so comparing them separately would miss the case
 * this function exists to catch.
 */
function groupOf(kind: string): string {
  return kind === "whatsapp" ? "phone" : kind;
}

/**
 * The value a group is compared on, which is looser than the value a party is
 * resolved on, deliberately.
 *
 * `normaliseIdentifier` has to be exact: it decides who a message belongs to,
 * and a wrong match files a customer's mail on a stranger's timeline. This
 * decides only whether a pair is worth *proposing* for a merge, where the cost
 * of being generous is a review-queue entry — so a number written with a
 * country code and the same number written without one compare equal here and
 * do not resolve as one identity there.
 */
function comparableValue(kind: string, value: string): string {
  return groupOf(kind) === "phone" ? normalisePhone(value) : normaliseEmail(value);
}

/**
 * One record's identifiers, grouped and reduced to comparable values.
 *
 * The contact columns are folded in as identifiers of the kind they name, which
 * is the whole of their role now — the caller that has a `party_identifiers`
 * row for the same address simply produces the same entry twice, and a set
 * absorbs it.
 */
function identitiesOf(fingerprint: PartyFingerprint): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();

  const add = (kind: string, value: string | null | undefined): void => {
    const comparable = comparableValue(kind, value ?? "");
    if (!comparable) return;
    const group = groupOf(kind);
    const bucket = grouped.get(group) ?? new Set<string>();
    bucket.add(comparable);
    grouped.set(group, bucket);
  };

  for (const identity of fingerprint.identifiers ?? []) add(identity.kind, identity.value);
  add("email", fingerprint.email);
  add("phone", fingerprint.phone);

  return grouped;
}

/** The domains of the email addresses a record holds. */
function domainsOf(identities: Map<string, Set<string>>): Set<string> {
  const domains = new Set<string>();
  for (const address of identities.get("email") ?? []) {
    const domain = emailDomain(address);
    if (domain) domains.add(domain);
  }
  return domains;
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

  const identities = [identitiesOf(left), identitiesOf(right)] as const;

  for (const [group, weight] of IDENTITY_WEIGHTS) {
    const shared = [...(identities[0].get(group) ?? [])].some((value) =>
      identities[1].get(group)?.has(value),
    );
    if (shared) matched.push({ signal: group, weight });
  }

  /**
   * Two colleagues at one company, which is a weak hint and never identity.
   *
   * Only counted when no address matched outright — otherwise it would score
   * the same agreement twice.
   */
  const sharedEmail = matched.some((entry) => entry.signal === "email");
  const domains = [domainsOf(identities[0]), domainsOf(identities[1])] as const;
  const sharedDomain = [...domains[0]].some((domain) => domains[1].has(domain));
  if (!sharedEmail && sharedDomain) matched.push({ signal: "email-domain", weight: 0.12 });

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
    ["tax-number", "email", "phone", "handle"].includes(signal),
  );

  const verdict: MergeVerdict =
    blockers.length === 0 && score >= AUTO_MERGE_THRESHOLD && identifying
      ? "auto-merge"
      : score >= REVIEW_THRESHOLD
        ? "review"
        : "distinct";

  return { score: Number(score.toFixed(4)), verdict, signals, blockers };
}
