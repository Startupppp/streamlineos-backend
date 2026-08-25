/**
 * Working out what a column means, without asking a model first.
 *
 * A CRM export's headers are a small, well-known vocabulary — "Company Name",
 * "Account Name", "Organisation" and "Company / Account" are the same field in
 * four products. That is a lookup, not a judgement, and the deterministic answer
 * is free, instant and exactly right where it fires. The model tier exists for
 * the genuinely odd header, not for `Email`.
 *
 * Ambiguity resolves to `unmapped`, never to a guess. A column silently mapped
 * to the wrong field writes wrong data into every row of the file, and the user
 * only finds out later — which is the one outcome an import must not have.
 */

/** The fields an import can land on today. */
export const IMPORT_FIELDS = [
  "name",
  "legalName",
  "displayName",
  "email",
  "phone",
  "website",
  "taxNumber",
  "notes",
  "partyType",
  "status",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export type ColumnMapping =
  | { readonly kind: "mapped"; readonly field: ImportField; readonly confidence: number }
  | { readonly kind: "custom"; readonly key: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly ImportField[] }
  | { readonly kind: "unmapped" };

export interface MappedColumn {
  readonly header: string;
  readonly mapping: ColumnMapping;
}

/**
 * Header spellings seen in real exports, per field.
 *
 * Compared after normalisation, so `Company Name`, `company_name` and
 * `COMPANY NAME` are one entry rather than three.
 */
const SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  name: [
    "name", "company", "company name", "account", "account name", "organisation",
    "organization", "organisation name", "organization name", "business name",
    "customer", "customer name", "client", "client name", "company account",
  ],
  legalName: ["legal name", "registered name", "legal entity", "legal entity name", "trading name"],
  displayName: ["display name", "short name", "nickname", "friendly name", "alias"],
  email: ["email", "e mail", "email address", "primary email", "work email", "contact email", "mail"],
  phone: [
    "phone", "telephone", "phone number", "primary phone", "work phone", "mobile",
    "mobile number", "contact number", "tel", "office phone",
  ],
  website: [
    "website", "web site", "url", "web", "homepage", "site", "company website",
    // "Company Domain Name" is HubSpot's domain field. Listed as a phrase so it
    // beats the bare "name" that also ends that header.
    "domain", "domain name", "company domain name", "web address",
  ],
  taxNumber: ["tax number", "tax id", "vat", "vat number", "gst", "gstin", "abn", "ein", "tax registration"],
  notes: ["notes", "note", "description", "comments", "remarks", "background", "about"],
  partyType: ["type", "party type", "account type", "record type", "relationship", "category"],
  status: ["status", "state", "account status", "lifecycle stage", "stage"],
};

/**
 * Headers that name a field we deliberately do not import.
 *
 * Recorded rather than ignored so the preview can say "left alone" instead of
 * silently dropping a column the user can see in their file. An identifier from
 * another system is the clearest case: importing it as a name would be absurd,
 * and importing it as our id would be worse.
 */
const KNOWN_IGNORED = new Set([
  "id", "record id", "row id", "created at", "created date", "create date",
  "updated at", "updated date", "modified date", "last modified", "owner id",
  "created by", "modified by", "last activity date",
]);

/**
 * Trailing words that make a header an identifier or a timestamp from elsewhere.
 *
 * Checked on the head noun rather than the whole header, so "Organization - ID"
 * and "Account ID" are recognised without listing every product's prefix.
 */
const IGNORABLE_HEAD = new Set(["id", "ids", "uuid", "guid", "date", "at", "by", "time"]);

export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    // Punctuation a spreadsheet adds: "Company / Account", "Company (Account)".
    .replace(/[_\-/\\().]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What one header means.
 *
 * Exact synonym match wins outright. Failing that, a header that contains a
 * synonym as a whole phrase is a weaker match — `Primary Contact Email` should
 * find `email` — but a header matching two fields that way is **ambiguous**
 * rather than resolved by whichever list happened to be searched first.
 */
export function mapColumn(header: string): ColumnMapping {
  const normalised = normaliseHeader(header);
  if (!normalised) return { kind: "unmapped" };
  if (KNOWN_IGNORED.has(normalised)) return { kind: "unmapped" };

  for (const field of IMPORT_FIELDS)
    if (SYNONYMS[field].includes(normalised)) return { kind: "mapped", field, confidence: 1 };

  /**
   * Failing an exact match, the field is whatever the header's HEAD NOUN names.
   *
   * English column names qualify left to right, so the last thing is the thing:
   * "Company Phone" is a phone, "Billing Email" is an email — and, just as
   * importantly, "Account Number" is a number and "Company Owner" is an owner.
   * A synonym that appears earlier is describing the head noun, not naming the
   * field, and treating it as the answer is how every phone number in a file
   * ends up in the name column.
   *
   * So only a synonym that reaches the end of the header counts. Among those,
   * the longest wins: "Company Domain Name" is a domain, not a name.
   */
  const head = IMPORT_FIELDS.map((field) => ({
    field,
    length: longestTrailingSynonym(normalised, SYNONYMS[field]),
  })).filter((candidate) => candidate.length > 0);

  if (head.length > 0) {
    const longest = Math.max(...head.map((candidate) => candidate.length));
    const winners = head.filter((candidate) => candidate.length === longest);

    if (winners.length === 1)
      return { kind: "mapped", field: winners[0]!.field, confidence: 0.7 };

    // Two synonyms of the same length ending the same header: a real tie.
    return { kind: "ambiguous", candidates: winners.map((candidate) => candidate.field) };
  }

  /**
   * No recognised head noun. If the header ends in an identifier or a date
   * word, it is another system's bookkeeping and we leave it alone.
   */
  const lastWord = normalised.split(" ").at(-1) ?? "";
  if (IGNORABLE_HEAD.has(lastWord)) return { kind: "unmapped" };

  /**
   * Everything else becomes a custom field rather than being dropped.
   *
   * A column the user can see in their file and cannot find after importing is
   * data loss they discover months later. Every entity carries JSONB custom
   * fields precisely so an unknown column has somewhere to go.
   */
  return { kind: "custom", key: customKeyFor(normalised) };
}

/**
 * The longest synonym that ENDS this header, or 0 if none does.
 *
 * Ending is what makes it the head noun. Whole-phrase, so `mail` does not match
 * inside `email`; short synonyms are skipped because a three-letter fragment
 * matches far too much.
 */
function longestTrailingSynonym(haystack: string, needles: readonly string[]): number {
  let best = 0;
  for (const needle of needles) {
    if (needle.length < 4) continue;
    if (haystack === needle || haystack.endsWith(` ${needle}`))
      best = Math.max(best, needle.length);
  }
  return best;
}


/** A stable, readable key. Two files with the same header land in one place. */
export function customKeyFor(normalisedHeader: string): string {
  return normalisedHeader.replace(/\s+/g, "_").slice(0, 60);
}

/**
 * Map a whole header row, refusing to map one field twice.
 *
 * A file with both `Company` and `Account Name` would otherwise map both to
 * `name`, and the second silently overwrites the first for every row. The
 * first wins and the rest become ambiguous, so a person decides.
 */
export function mapColumns(headers: readonly string[]): MappedColumn[] {
  const taken = new Set<ImportField>();

  return headers.map((header) => {
    const mapping = mapColumn(header);

    if (mapping.kind === "mapped") {
      if (taken.has(mapping.field))
        return { header, mapping: { kind: "ambiguous", candidates: [mapping.field] } };
      taken.add(mapping.field);
    }

    return { header, mapping };
  });
}

/**
 * Columns a person has to answer for before the import can run.
 *
 * Only the genuinely ambiguous ones. A column with exactly one plausible
 * reading is not a question, and asking about every partial match turns a
 * single confirmation into a form nobody reads — which is how the wrong answer
 * gets clicked through. Every mapping is still shown in the preview and every
 * one can be overridden there.
 */
export function needsConfirmation(columns: readonly MappedColumn[]): MappedColumn[] {
  return columns.filter((column) => column.mapping.kind === "ambiguous");
}
