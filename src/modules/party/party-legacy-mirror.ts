import {
  LEGACY_OWNED_COLUMNS,
  PARTY_FIELD_MIRROR,
  type ClientInsert,
  type ContactInsert,
  type ErasedRow,
  type LeadInsert,
  type MirrorCell,
  type PartyPatch,
  type PartyRow,
} from "./party-mirror-fields";
import type { MappedLegacyKind } from "./party-legacy-seam";

/**
 * The one place a legacy row is produced from a Party row.
 *
 * From this ticket onward Party is canonical and `leads`, `clients` and
 * `contacts` are a mirror of it. Two forms of the same customer can only stay
 * agreed if one of them is *computed* from the other, so nothing writes a legacy
 * row independently: every write path derives its legacy values from the Party
 * row it just wrote, and the divergence check re-runs that same derivation and
 * diffs it against what is on disk. There is deliberately no second mapper to
 * fall out of step with this one.
 *
 * The field-by-field decisions live in `party-mirror-fields.ts`; this is the
 * machinery that reads them.
 */

/**
 * Re-exported so a caller needs one import for the row type and the engine
 * that operates on it. Everything else about the field map stays behind
 * `party-mirror-fields.ts`.
 */
export type { PartyPatch, PartyRow, ErasedRow } from "./party-mirror-fields";
export { LEGACY_OWNED_COLUMNS, PARTY_FIELD_MIRROR } from "./party-mirror-fields";

/**
 * A fully-populated Party row, used only to learn which legacy columns each cell
 * owns.
 *
 * The alternative is for every cell to declare its own column list beside
 * `derive`, which is a second declaration one line away from the first and
 * therefore a second thing to forget. Probing the derivations means the reverse
 * index cannot disagree with the forward one — it is computed from it.
 *
 * Exhaustive over `PartyRow` on purpose: adding a column to `business_parties`
 * fails here as well as at the map's own annotation, so the compiler asks twice
 * and from two files. The values are arbitrary; only the shape of what `derive`
 * returns is read.
 */
const MIRROR_PROBE: PartyRow = {
  partyId: "probe",
  organizationId: "probe",
  partyType: "CUSTOMER",
  name: "probe",
  legalName: "probe",
  displayName: "probe",
  taxNumber: "probe",
  website: "probe",
  email: "probe",
  phone: "probe",
  status: "active",
  customFields: {},
  notes: "probe",
  jobTitle: "probe",
  department: "probe",
  companyName: "probe",
  whatsappPhone: "probe",
  avatarUrl: "probe",
  linkedinUrl: "probe",
  socialProfiles: {},
  city: "probe",
  state: "probe",
  lifecycleStage: "NEW",
  priority: "WARM",
  qualificationScore: 0,
  convertedAt: null,
  lostReason: null,
  slaDueAt: null,
  nextFollowUpAt: null,
  followUpNotes: null,
  acquisitionSource: "other",
  acquisitionSubSource: null,
  acquisitionCampaignId: null,
  acquisitionContext: {},
  referredBy: null,
  ownerUserId: null,
  assignedByUserId: null,
  assignedAt: null,
  verifiedByUserId: null,
  statedBudget: null,
  expectedValue: null,
  lifetimeValue: null,
  healthScore: null,
  healthStatus: null,
  healthCheckedAt: null,
  churnRiskScore: null,
  churnRiskReasoning: null,
  tags: [],
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};


/**
 * The engine, built once per legacy table and typed to that table.
 *
 * Deliberately not one generic function taking a kind: the moment the table is
 * chosen at runtime, `Partial<LeadInsert>` and `Partial<ContactInsert>` collapse
 * to `Record<string, unknown>` and every one of the checks the map earns above is
 * gone. Three concrete engines keep `derive` returning something Drizzle will
 * accept and `absorb` receiving something it can read by name.
 */
export interface MirrorEngine<TInsert> {
  /** Every legacy column the mirror writes. */
  readonly columns: readonly string[];
  /** The legacy row this Party row means — total over `columns`, nulls included. */
  derive(party: PartyRow): Partial<TInsert>;
  /** Where a stored legacy row disagrees with the Party it mirrors. */
  diff(party: PartyRow, stored: ErasedRow): MirrorFieldDivergence[];
  /** Splits a legacy-shaped patch into what Party owns and what it does not. */
  split(patch: Partial<TInsert>, current: PartyRow): SplitLegacyPatch<TInsert>;
}

export interface MirrorFieldDivergence {
  readonly column: string;
  readonly partyColumn: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface SplitLegacyPatch<TInsert> {
  /** What the Party row must become for the mirror to derive back to this patch. */
  readonly partyPatch: PartyPatch;
  /** Columns Party does not own, written straight onto the legacy row. */
  readonly legacyOwnedPatch: Partial<TInsert>;
}

interface NamedCell<TInsert> {
  readonly partyColumn: string;
  readonly columns: readonly string[];
  readonly cell: MirrorCell<TInsert>;
}

function buildEngine<TInsert>(
  cells: readonly NamedCell<TInsert>[],
  legacyOwned: Readonly<Record<string, string>>,
): MirrorEngine<TInsert> {
  const owningCell = new Map<string, NamedCell<TInsert>>();
  for (const named of cells) for (const column of named.columns) owningCell.set(column, named);

  const derive = (party: PartyRow): Partial<TInsert> => {
    const row: Partial<TInsert> = {};
    for (const named of cells) Object.assign(row, named.cell.derive(party));
    return row;
  };

  return {
    columns: [...owningCell.keys()],
    derive,

    diff(party, stored) {
      const divergences: MirrorFieldDivergence[] = [];
      for (const [column, expected] of Object.entries(derive(party))) {
        if (valuesAgree(expected, stored[column])) continue;
        divergences.push({
          column,
          partyColumn: owningCell.get(column)?.partyColumn ?? "unknown",
          expected: forReport(expected),
          actual: forReport(stored[column]),
        });
      }
      return divergences;
    },

    split(patch, current) {
      const partyPatch: PartyPatch = {};
      const legacyOwnedPatch: Partial<TInsert> = {};
      const touched = new Set<NamedCell<TInsert>>();

      for (const [column, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const named = owningCell.get(column);
        if (named) {
          touched.add(named);
          continue;
        }
        if (column in legacyOwned) {
          Object.assign(legacyOwnedPatch, { [column]: value });
          continue;
        }
        throw new Error(
          `Legacy column "${column}" is neither mirrored from a Party column nor declared legacy-owned in party-legacy-mirror.ts`,
        );
      }

      // Whole cells, not single columns: a cell spanning seven legacy columns has
      // to see all seven at once to fold them back into one jsonb.
      for (const named of touched) Object.assign(partyPatch, named.cell.absorb(patch, current));

      return { partyPatch, legacyOwnedPatch };
    },
  };
}

function leadCells(): NamedCell<LeadInsert>[] {
  const named: NamedCell<LeadInsert>[] = [];
  for (const [partyColumn, entry] of Object.entries(PARTY_FIELD_MIRROR)) {
    if ("legacyHasNoColumn" in entry || !("LEAD" in entry)) continue;
    const cell = entry.LEAD;
    if (cell) named.push({ partyColumn, columns: Object.keys(cell.derive(MIRROR_PROBE)), cell });
  }
  return named;
}

function clientCells(): NamedCell<ClientInsert>[] {
  const named: NamedCell<ClientInsert>[] = [];
  for (const [partyColumn, entry] of Object.entries(PARTY_FIELD_MIRROR)) {
    if ("legacyHasNoColumn" in entry || !("CLIENT" in entry)) continue;
    const cell = entry.CLIENT;
    if (cell) named.push({ partyColumn, columns: Object.keys(cell.derive(MIRROR_PROBE)), cell });
  }
  return named;
}

function contactCells(): NamedCell<ContactInsert>[] {
  const named: NamedCell<ContactInsert>[] = [];
  for (const [partyColumn, entry] of Object.entries(PARTY_FIELD_MIRROR)) {
    if ("legacyHasNoColumn" in entry || !("CONTACT" in entry)) continue;
    const cell = entry.CONTACT;
    if (cell) named.push({ partyColumn, columns: Object.keys(cell.derive(MIRROR_PROBE)), cell });
  }
  return named;
}

/**
 * Legacy columns Party does not and will not own, and why.
 *
 * Every column of the three tables is either derived from a Party column above
 * or named here; the spec asserts the union is exact. Without that half, a column
 * added to `leads` next year would sit outside the mirror with nothing saying
 * whether that was a decision.
 */


export const LEAD_MIRROR = buildEngine(leadCells(), LEGACY_OWNED_COLUMNS.LEAD);
export const CLIENT_MIRROR = buildEngine(clientCells(), LEGACY_OWNED_COLUMNS.CLIENT);
export const CONTACT_MIRROR = buildEngine(contactCells(), LEGACY_OWNED_COLUMNS.CONTACT);

/**
 * The kind-dispatched half, for the divergence sweep.
 *
 * Only `columns` and `diff` are here: both read a row rather than produce one, so
 * erasing the table type costs nothing. Anything that writes goes through the
 * typed engine for its kind.
 */
export function mirroredColumns(kind: MappedLegacyKind): readonly string[] {
  if (kind === "LEAD") return LEAD_MIRROR.columns;
  if (kind === "CLIENT") return CLIENT_MIRROR.columns;
  return CONTACT_MIRROR.columns;
}

export function diffLegacyMirror(
  kind: MappedLegacyKind,
  party: PartyRow,
  stored: ErasedRow,
): MirrorFieldDivergence[] {
  if (kind === "LEAD") return LEAD_MIRROR.diff(party, stored);
  if (kind === "CLIENT") return CLIENT_MIRROR.diff(party, stored);
  return CONTACT_MIRROR.diff(party, stored);
}

/**
 * Equality across the type gap between what we wrote and what Postgres returns.
 *
 * Numerics come back as strings, timestamps as `Date`, `text[]` and jsonb as
 * structures. Comparing with `===` would report every decimal and every date as
 * divergent and drown the answer that matters.
 */
export function valuesAgree(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (expected == null || actual == null) return expected == null && actual == null;

  if (expected instanceof Date || actual instanceof Date) {
    const left = expected instanceof Date ? expected.getTime() : Date.parse(String(expected));
    const right = actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }

  // `investment_value` is `numeric(15,2)`: "1000" and "1000.00" are the same
  // money, and only one of them is what the column rounds to.
  if (isNumericScalar(expected) && isNumericScalar(actual)) {
    const left = Number(expected);
    const right = Number(actual);
    if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
    return false;
  }

  if (Array.isArray(expected) && Array.isArray(actual))
    return (
      expected.length === actual.length &&
      expected.every((value, index) => valuesAgree(value, actual[index]))
    );

  if (typeof expected === "object" && typeof actual === "object") {
    const left: ErasedRow = { ...expected };
    const right: ErasedRow = { ...actual };
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      if (!valuesAgree(left[key], right[key])) return false;
    return true;
  }

  return false;
}

function isNumericScalar(value: unknown): boolean {
  if (typeof value === "number") return true;
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** Dates do not survive JSON, and the report is read by people. */
function forReport(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

