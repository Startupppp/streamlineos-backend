import {
  fieldsFor,
  groupOf,
  IDENTITY_FIELDS,
  synonymsFor,
  type ImportEntity,
  type ImportField,
} from "./import-entities";

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
 *
 * ── Why the entity is a parameter ──────────────────────────────────────────
 *
 * "Stage" means a party's lifecycle on an accounts export and a deal's position
 * on an opportunities one; "Amount" means nothing at all on either. So the
 * vocabulary is per entity and lives in `import-entities.ts`, while the RULES
 * below — head noun, exact-wins, cross-reference — are shared, because they are
 * properties of how English column names are written rather than of what is
 * being imported. The entity defaults to `party` so that every existing caller,
 * including the mapping evals, keeps its exact answers.
 */

export { IDENTITY_FIELDS, isFieldOf, type ImportEntity, type ImportField } from "./import-entities";

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
 * Headers that name a field we deliberately do not import.
 *
 * Recorded rather than ignored so the preview can say "left alone" instead of
 * silently dropping a column the user can see in their file. An identifier from
 * another system is the clearest case: importing it as a name would be absurd,
 * and importing it as our id would be worse.
 *
 * The modification timestamps matter more now than they did: an activities
 * import reads "date" as when something happened, and "Last Modified Date" read
 * that way would land every message in a mail folder at the moment somebody last
 * touched the record.
 */
const KNOWN_IGNORED = new Set([
  "id", "record id", "row id", "created at", "created date", "create date",
  "updated at", "updated date", "modified date", "last modified", "owner id",
  "created by", "modified by", "last activity date",
  "last modified date", "date created", "date modified", "date updated",
]);

/**
 * Trailing words that make a header an identifier or a timestamp from elsewhere.
 *
 * Checked on the head noun rather than the whole header, so "Organization - ID"
 * and "Account ID" are recognised without listing every product's prefix.
 */
const IGNORABLE_HEAD = new Set([
  "id", "ids", "uuid", "guid", "date", "at", "by", "time",
  // Pipedrive writes its timestamps as "Organization - Created" and
  // "Person - Updated", with no "date" or "time" to recognise them by. Same
  // bookkeeping as "Created Date"; only the spelling differs.
  "created", "modified", "updated",
]);

export function isIdentityField(field: string): boolean {
  return (IDENTITY_FIELDS as readonly string[]).includes(field);
}

/**
 * Words that make everything after them belong to a DIFFERENT record.
 *
 * Two kinds, and the reason is the same for both. `Account Owner Email` is the
 * sales rep's address, not the customer's; `Asst. Phone` is a receptionist's
 * line that fifty contacts share; `Parent Account` and `Associated Company`
 * name a company that is not this row. Read as identity, each one hands the
 * same e-mail address, phone number or name to every row that mentions the same
 * rep, receptionist or parent — and rows that share an identifier are exactly
 * what the duplicate scorer merges. That is how one customer becomes another,
 * and it arrives at the scale of a file rather than one record at a time.
 *
 * These sit before the head noun, which is what distinguishes them from the
 * qualifiers that are fine: `Company Phone` and `Billing Email` are still this
 * party's phone and e-mail, because "company" and "billing" describe the row
 * rather than pointing away from it.
 */
const FOREIGN_QUALIFIERS = new Set([
  // Another person: whoever in OUR organisation, or theirs, is attached to the row.
  "owner", "assistant", "asst", "manager", "creator", "referrer", "referred",
  "reports", "assigned", "by",
  // Another record: a company, deal or activity related to this one.
  "parent", "ultimate", "associated", "related", "linked", "master",
  "deal", "opportunity", "quote", "activity", "task", "meeting", "call",
]);

/**
 * Nouns that name a kind of record, grouped by which kind.
 *
 * Needed for one shape the list above cannot express. Pipedrive spells every
 * export header `Entity - Field`, so a Persons export carries
 * `Person - Organization` — the company that person belongs to. Its head noun is
 * `organization`, a synonym of `name`, so without this it reads as the party's
 * own name and every person at one company collapses into that company.
 *
 * Grouped rather than listed flat because `Company / Account` is a real single
 * header meaning one thing, and `company account` must not look like a
 * cross-reference to itself. Same group means the header says the same kind of
 * record twice; different groups mean it points at another one.
 */
const ENTITY_GROUP: Readonly<Record<string, string>> = {
  company: "org", account: "org", organisation: "org", organization: "org",
  business: "org", client: "org", customer: "org", vendor: "org", supplier: "org",
  person: "person", contact: "person", individual: "person",
  deal: "deal", opportunity: "deal", pipeline: "deal", quote: "deal",
  activity: "activity", task: "activity",
};

/**
 * Whether the words before the head noun make this column somebody else's.
 *
 * Applied to every field rather than only the identity ones. The rule is about
 * provenance — the value is not this record's — and that is true of a parent
 * account's description as much as of its e-mail address. Refusing uniformly is
 * also the module's existing doctrine: ambiguity resolves away from a guess, and
 * "whose is this?" is exactly the question a person can answer from the preview.
 *
 * `entityGroup` is the fallback when the head noun names no kind of record on
 * its own. That is what tells a deals export that "Account Name" is the
 * customer while "Deal Name" is the deal — read the other way, every
 * opportunity in the file is renamed after the company it belongs to and the
 * real deal names are gone. Parties leave it unset, so their answers cannot
 * move: `Primary Contact Email` is still the party's e-mail address there.
 */
function isCrossReference(
  prefixWords: readonly string[],
  headWord: string,
  entityGroup: string | undefined,
): boolean {
  if (prefixWords.some((word) => FOREIGN_QUALIFIERS.has(word))) return true;

  const headGroup = ENTITY_GROUP[headWord] ?? entityGroup;
  if (!headGroup) return false;

  return prefixWords.some((word) => {
    const group = ENTITY_GROUP[word];
    return group !== undefined && group !== headGroup;
  });
}

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
 * What one header means, for the entity this file is being imported as.
 *
 * Exact synonym match wins outright. Failing that, a header that contains a
 * synonym as a whole phrase is a weaker match — `Primary Contact Email` should
 * find `email` — but a header matching two fields that way is **ambiguous**
 * rather than resolved by whichever list happened to be searched first.
 */
export function mapColumn(header: string, entity: ImportEntity = "party"): ColumnMapping {
  const normalised = normaliseHeader(header);
  if (!normalised) return { kind: "unmapped" };
  if (KNOWN_IGNORED.has(normalised)) return { kind: "unmapped" };

  const fields = fieldsFor(entity);

  for (const field of fields)
    if (synonymsFor(entity, field).includes(normalised))
      return { kind: "mapped", field, confidence: 1 };

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
  const head = fields
    .map((field) => ({
      field,
      length: longestTrailingSynonym(normalised, synonymsFor(entity, field)),
    }))
    .filter((candidate) => candidate.length > 0);

  if (head.length > 0) {
    const longest = Math.max(...head.map((candidate) => candidate.length));
    const winners = head.filter((candidate) => candidate.length === longest);

    /**
     * Whose value is this, before deciding what it is.
     *
     * Only the words the matched synonym did not cover count as qualifiers, so
     * `Company Domain Name` — where the synonym IS the whole header — has no
     * prefix to judge, while `Parent Account` has "parent". Checked here rather
     * than at the top of the function because an EXACT synonym is a header a
     * product chose to mean one field, and none of them contains a qualifier
     * that points elsewhere; it is the partial, head-noun match that can be a
     * relationship dressed as a field.
     */
    const prefix = normalised.slice(0, normalised.length - longest).trim();
    if (prefix) {
      const headWord = normalised.split(" ").at(-1) ?? "";
      if (isCrossReference(prefix.split(" "), headWord, groupOf(entity)))
        /**
         * A custom field, not `unmapped`. The column is real and the user can
         * see it in their file; it simply describes another record. Keeping it
         * under its own header means "Account Owner Email" is still there to be
         * read, and is not an address anybody is matched on.
         */
        return { kind: "custom", key: customKeyFor(normalised) };
    }

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
export function mapColumns(
  headers: readonly string[],
  entity: ImportEntity = "party",
): MappedColumn[] {
  const taken = new Set<ImportField>();

  return headers.map((header) => {
    const mapping = mapColumn(header, entity);

    if (mapping.kind === "mapped") {
      if (taken.has(mapping.field))
        return { header, mapping: { kind: "ambiguous", candidates: [mapping.field] } };
      taken.add(mapping.field);
    }

    return { header, mapping };
  });
}

/**
 * The fields claimed by more than one column, with the headers claiming them.
 *
 * `mapColumns` enforces this on the automatic path by turning the second
 * claimant ambiguous, but that guard runs before a person's overrides are
 * applied — and an override names a field outright, so it can re-create exactly
 * the collision the guard exists to prevent. Reported rather than resolved:
 * which of two columns the user meant is the question they were being asked,
 * and picking the rightmost silently is the failure, not the fix.
 */
export function duplicateFieldAssignments(
  columns: readonly MappedColumn[],
): { field: ImportField; headers: string[] }[] {
  const byField = new Map<ImportField, string[]>();

  for (const column of columns) {
    if (column.mapping.kind !== "mapped") continue;
    const headers = byField.get(column.mapping.field) ?? [];
    headers.push(column.header);
    byField.set(column.mapping.field, headers);
  }

  return [...byField.entries()]
    .filter(([, headers]) => headers.length > 1)
    .map(([field, headers]) => ({ field, headers }));
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
