/**
 * Deciding what the surviving record looks like after a merge.
 *
 * Two rules, and the second is the one that matters. A field the survivor left
 * empty is filled from the other record, because that is the whole benefit of
 * merging. A field both filled in differently is *not* silently resolved: the
 * survivor's value stands and the other is recorded as a conflict, so the
 * information is still there for whoever looks.
 *
 * Pure: what a merge does to the data is decided here and executed elsewhere.
 */

export type PartyFieldValue = string | number | boolean | null | undefined;

/** Fields carried across. Identity, timestamps and tenancy are never merged. */
export const MERGEABLE_FIELDS = [
  "name",
  "legalName",
  "displayName",
  "taxNumber",
  "website",
  "email",
  "phone",
  "notes",
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export interface FieldConflict {
  readonly kept: PartyFieldValue;
  readonly discarded: PartyFieldValue;
}

export interface MergePlan {
  /**
   * Fields to write onto the survivor, filled from the other record.
   *
   * Always strings: every mergeable column is text, and only a non-empty value
   * is ever copied, so a wider type here would only push a cast onto the caller.
   */
  readonly survivorPatch: Partial<Record<MergeableField, string>>;
  /** Fields both records filled in differently. The survivor's value stands. */
  readonly conflicts: Partial<Record<MergeableField, FieldConflict>>;
  /** Custom fields are unioned; the survivor wins a shared key. */
  readonly customFields: Record<string, unknown> | null;
}

function isEmpty(value: PartyFieldValue): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

export interface MergeableRecord {
  readonly customFields?: Record<string, unknown> | null;
  readonly [field: string]: unknown;
}

export function planMerge(survivor: MergeableRecord, merged: MergeableRecord): MergePlan {
  const survivorPatch: Partial<Record<MergeableField, string>> = {};
  const conflicts: Partial<Record<MergeableField, FieldConflict>> = {};

  for (const field of MERGEABLE_FIELDS) {
    const keep = survivor[field] as PartyFieldValue;
    const other = merged[field] as PartyFieldValue;

    if (isEmpty(other)) continue;

    if (isEmpty(keep)) {
      survivorPatch[field] = String(other);
      continue;
    }

    if (keep !== other) conflicts[field] = { kept: keep, discarded: other };
  }

  const survivorCustom = survivor.customFields ?? null;
  const mergedCustom = merged.customFields ?? null;

  // Union, survivor wins a shared key — the same rule as the columns above, so a
  // tenant's own fields behave no differently from the built-in ones.
  const customFields =
    survivorCustom || mergedCustom ? { ...mergedCustom, ...survivorCustom } : null;

  return { survivorPatch, conflicts, customFields };
}

/**
 * Which of the pair survives.
 *
 * The older record wins. It is the one other systems, exports and people's
 * bookmarks are most likely to already reference, and keeping the identifier
 * that has been around longest breaks the fewest things. Ties fall to the
 * lexicographically smaller id purely so the choice is deterministic.
 */
export function chooseSurvivor(
  a: { partyId: string; createdAt: Date },
  b: { partyId: string; createdAt: Date },
): { survivor: string; merged: string } {
  const aFirst =
    a.createdAt.getTime() === b.createdAt.getTime()
      ? a.partyId < b.partyId
      : a.createdAt.getTime() < b.createdAt.getTime();

  return aFirst
    ? { survivor: a.partyId, merged: b.partyId }
    : { survivor: b.partyId, merged: a.partyId };
}

/** Stable ordering so a pair cannot be queued twice under two arrangements. */
export function orderPair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}
