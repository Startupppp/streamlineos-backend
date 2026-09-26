import { canonicalAdmissionEmail } from "../../organization/core/membership-admission.service";

/**
 * HRM-15. The one definition of the manager columns a spreadsheet row may carry.
 *
 * Bulk onboarding and the staged employee import both read these columns, and
 * the PRD forbids a second definition of `managerEmail` semantics (§7.4). Headers
 * match loosely (case, spaces, `_` and `-` are ignored) because they come from a
 * hand-edited sheet; values are only trimmed and lower-cased here, so a malformed
 * address still reaches the row schema and fails there with a field error —
 * callers parse the returned `row`, not the convenience fields, for that reason.
 */

export const PRIMARY_MANAGER_COLUMN = "primaryManagerEmail";

/** Read for one release, never written into a new template (PRD §7.3, §8.4). */
export const LEGACY_PRIMARY_MANAGER_COLUMNS = ["reportingManagerEmail", "reportsTo", "managerEmail"] as const;

export const SECONDARY_MANAGER_COLUMNS = [
  "secondaryManagerEmail1",
  "secondaryManagerEmail2",
  "secondaryManagerEmail3",
] as const;

export type ManagerColumnsResult =
  | {
      ok: true;
      /** The row with every manager header rewritten to its canonical key. */
      row: Record<string, unknown>;
      primaryManagerEmail: string | null;
      /** Slot order is kept, so `[null, "b@x", null]` still says the file used column 2. */
      secondaryManagerEmails: [string | null, string | null, string | null];
      /** The legacy header the value came from, for `legacyManagerHeader` telemetry. */
      legacyHeader: string | null;
    }
  | {
      ok: false;
      /** Two headers for the same slot disagree; picking one would guess the operator's intent. */
      conflictingColumns: string[];
    };

function headerKey(header: string): string {
  return header.toLowerCase().replace(/[\s_-]/g, "");
}

const CANONICAL_BY_HEADER = new Map<string, string>([
  [headerKey(PRIMARY_MANAGER_COLUMN), PRIMARY_MANAGER_COLUMN],
  ...LEGACY_PRIMARY_MANAGER_COLUMNS.map((column): [string, string] => [headerKey(column), PRIMARY_MANAGER_COLUMN]),
  ...SECONDARY_MANAGER_COLUMNS.map((column): [string, string] => [headerKey(column), column]),
]);

function cellValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : canonicalAdmissionEmail(trimmed);
}

function isLegacy(header: string): boolean {
  const key = headerKey(header);
  return LEGACY_PRIMARY_MANAGER_COLUMNS.some((column) => headerKey(column) === key);
}

function emailOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normaliseManagerColumns(input: Readonly<Record<string, unknown>>): ManagerColumnsResult {
  const row: Record<string, unknown> = {};
  const sources = new Map<string, Array<{ header: string; value: unknown }>>();

  for (const [header, raw] of Object.entries(input)) {
    const canonical = CANONICAL_BY_HEADER.get(headerKey(header));
    if (canonical === undefined) {
      row[header] = raw;
      continue;
    }
    const entries = sources.get(canonical) ?? [];
    entries.push({ header, value: cellValue(raw) });
    sources.set(canonical, entries);
  }

  const conflictingColumns: string[] = [];
  let legacyHeader: string | null = null;
  for (const [canonical, entries] of sources) {
    const filled = entries.filter((entry) => entry.value !== null);
    const distinct = new Set(filled.map((entry) => entry.value));
    if (distinct.size > 1) {
      conflictingColumns.push(...filled.map((entry) => entry.header));
      continue;
    }
    const chosen = filled.find((entry) => !isLegacy(entry.header)) ?? filled[0];
    row[canonical] = chosen === undefined ? null : chosen.value;
    if (canonical === PRIMARY_MANAGER_COLUMN && chosen !== undefined && isLegacy(chosen.header))
      legacyHeader = chosen.header;
  }

  if (conflictingColumns.length > 0) return { ok: false, conflictingColumns };

  return {
    ok: true,
    row,
    primaryManagerEmail: emailOrNull(row[PRIMARY_MANAGER_COLUMN]),
    secondaryManagerEmails: [
      emailOrNull(row[SECONDARY_MANAGER_COLUMNS[0]]),
      emailOrNull(row[SECONDARY_MANAGER_COLUMNS[1]]),
      emailOrNull(row[SECONDARY_MANAGER_COLUMNS[2]]),
    ],
    legacyHeader,
  };
}
