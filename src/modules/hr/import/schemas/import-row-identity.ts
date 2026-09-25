import type { HrImportEntity } from "../dto/import-job.dto";

/**
 * In-file duplicate detection for HR imports.
 *
 * `validateRows` used to judge every row on its own, so a file that named the
 * same employee, the same serial number or the same person-day twice sailed
 * through preview reporting "N valid, 0 errors". What happened at commit then
 * depended on the entity: attendance hit its explicit same-day guard and failed
 * the second row with an error the preview never warned about, while assets and
 * documents inserted both rows and the operator was left with silent duplicates
 * they could only find by eye.
 *
 * The fix is one pass over the already-schema-valid rows, keyed per entity, that
 * fails the *later* row and names the row it collides with. Which columns make a
 * row "the same row" is declared here, in one place, so the identity a preview
 * enforces and the identity a commit upserts on cannot drift apart.
 */

export interface RowIdentityKey {
  /** What the operator sees: "email", "serial number", "employee + date". */
  label: string;
  /** Normalised comparison value. Empty string means "this row has no such key". */
  value: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** Emails compare case-insensitively: `QA@x.com` and `qa@x.com` are one person. */
function email(value: unknown): string {
  return text(value).toLowerCase();
}

/** Serials and employee numbers are printed on labels; case and padding are noise. */
export function normalizeCode(value: unknown): string {
  return text(value).toUpperCase();
}

/** Document and asset names compare on case-folded, whitespace-collapsed text. */
export function normalizeName(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

/**
 * Composes several fields into one comparison key. `JSON.stringify` is what keeps
 * `["ab", "c"]` and `["a", "bc"]` apart without reserving a separator character
 * that a name or category could itself contain.
 */
function composite(parts: readonly string[]): string {
  return parts.every((part) => part === "") ? "" : JSON.stringify(parts);
}

export function identityKeysOf(
  entity: HrImportEntity,
  row: Record<string, unknown>,
): RowIdentityKey[] {
  if (entity === "employees")
    return [
      { label: "email", value: email(row.email) },
      { label: "employee number", value: normalizeCode(row.employeeNumber) },
    ];

  if (entity === "leave_balances")
    return [
      {
        label: "employee + leave type + year",
        value: composite([email(row.employeeEmail), normalizeName(row.leaveTypeName), text(row.year)]),
      },
    ];

  if (entity === "attendance")
    return [
      {
        label: "employee + date",
        value: composite([email(row.employeeEmail), text(row.date)]),
      },
    ];

  if (entity === "assets")
    return [{ label: "serial number", value: normalizeCode(row.serialNumber) }];

  if (entity === "document_metadata")
    // PROVISIONAL — open product decision #2. The identity a document is
    // re-imported under is (employee, category, name); an exact repeat of the
    // same row is the duplicate this catches. Changing the key later is a code
    // change here and in `commitDocumentRow`, not a data migration, because no
    // unique index is built on it.
    return [
      {
        label: "employee + category + name",
        value: composite([
          email(row.employeeEmail),
          normalizeName(row.category),
          normalizeName(row.name),
        ]),
      },
    ];

  return [];
}

/**
 * Marks the later of two rows that share an identity key. Returns a message per
 * offending row number, or an empty map when the file is internally consistent.
 */
export function findInFileDuplicates(
  entity: HrImportEntity,
  rows: ReadonlyArray<{ rowNumber: number; payload: Record<string, unknown> }>,
): Map<number, string> {
  const firstSeen = new Map<string, number>();
  const duplicates = new Map<number, string>();

  for (const row of rows) {
    for (const key of identityKeysOf(entity, row.payload)) {
      if (key.value === "") continue;
      const scoped = `${key.label}=${key.value}`;
      const earlier = firstSeen.get(scoped);
      if (earlier === undefined) {
        firstSeen.set(scoped, row.rowNumber);
        continue;
      }
      if (!duplicates.has(row.rowNumber))
        duplicates.set(
          row.rowNumber,
          `Duplicate ${key.label} in this file — row ${earlier} already has the same value`,
        );
    }
  }

  return duplicates;
}
