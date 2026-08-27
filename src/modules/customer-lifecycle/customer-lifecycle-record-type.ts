import {
  CUSTOMER_HEALTH_BANDS,
  CUSTOMER_LIFECYCLE_STAGES,
  type CustomerHealthBand,
  type CustomerLifecycleStage,
} from "../../db/schema/crm/customer-lifecycle";

/**
 * The lifecycle as a description the renderer can draw, not a set of screens.
 *
 * Ticket 07's second criterion. The renderer takes its layout as data —
 * `RecordLayout` in `frontend/lib/renderer/layout.ts` — and `issue-record-types.ts`
 * already proves what that buys: a field declaration becomes a list, a detail
 * view and a form with no branch anywhere asking what kind of record it is. A
 * customer lifecycle is that same arrangement. Nothing in this module renders
 * anything; it serves the description, and every row the service returns is
 * keyed to match it.
 *
 * The interfaces below mirror the renderer's exactly rather than translating
 * into them, for the reason the issues module records: a translation layer is
 * where a field name drifts, and the failure is silent — a column whose name the
 * row does not carry renders as an empty cell, on every row, forever.
 */

/** Mirrors the renderer's `SelectOption`. */
export interface LifecycleFieldOption {
  readonly value: string;
  readonly label: string;
  /** Design-layer status tokens, never a raw colour. */
  readonly tone?: "success" | "warning" | "danger" | "info" | "neutral";
}

/** Mirrors the renderer's `FieldSpec`. */
export interface LifecycleFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "number" | "date" | "select" | "badge" | "longText";
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly options?: readonly LifecycleFieldOption[];
  readonly hint?: string;
}

export interface LifecycleColumnSpec {
  readonly field: string;
  readonly primary?: boolean;
  readonly sortable?: boolean;
  readonly width?: string;
  readonly subtitle?: string;
}

export interface LifecycleSectionSpec {
  readonly title: string;
  readonly fields: readonly string[];
}

/** Mirrors the renderer's `RecordLayout`. */
export interface LifecycleRecordLayout {
  readonly key: string;
  readonly recordType: "customer_lifecycle";
  readonly singular: string;
  readonly plural: string;
  readonly titleField: string;
  readonly fields: readonly LifecycleFieldSpec[];
  readonly list: {
    readonly columns: readonly LifecycleColumnSpec[];
    readonly searchPlaceholder: string;
  };
  readonly detail: { readonly sections: readonly LifecycleSectionSpec[] };
  readonly form: { readonly sections: readonly LifecycleSectionSpec[] };
}

const STAGE_TONES: Readonly<Record<CustomerLifecycleStage, LifecycleFieldOption["tone"]>> = {
  active: "success",
  renewal_open: "info",
  at_risk: "warning",
  renewed: "success",
  churned: "danger",
};

const BAND_TONES: Readonly<Record<CustomerHealthBand, LifecycleFieldOption["tone"]>> = {
  healthy: "success",
  at_risk: "warning",
  critical: "danger",
};

function titleCase(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Derived from the schema's own lists rather than restated, so a sixth stage
// reaches the layout by adding one tone instead of by somebody remembering to.
const STAGE_OPTIONS: readonly LifecycleFieldOption[] = CUSTOMER_LIFECYCLE_STAGES.map((stage) => ({
  value: stage,
  label: titleCase(stage),
  tone: STAGE_TONES[stage],
}));

const BAND_OPTIONS: readonly LifecycleFieldOption[] = CUSTOMER_HEALTH_BANDS.map((band) => ({
  value: band,
  label: titleCase(band),
  tone: BAND_TONES[band],
}));

/**
 * Every field the record shows, declared once.
 *
 * `stage` is read-only, and that is load-bearing rather than cosmetic: the
 * renderer's form drops read-only fields, so the generated form is physically
 * incapable of moving a lifecycle's stage. The stage moves when a trigger opens
 * an opportunity or when a renewal closes, and both of those write a signal — a
 * writable control here would let somebody set "renewed" with no record of why,
 * and criterion 4 turns on the history being complete.
 *
 * The health fields are read-only for a stronger reason: they are computed, and
 * a health score a person can type is not a health score.
 */
const FIELDS: readonly LifecycleFieldSpec[] = [
  { name: "customerName", label: "Customer", kind: "text", readOnly: true },
  {
    name: "stage",
    label: "Stage",
    kind: "badge",
    readOnly: true,
    options: STAGE_OPTIONS,
    hint: "Moved by a renewal or a churn trigger, never by editing the record.",
  },
  {
    name: "healthScore",
    label: "Health",
    kind: "number",
    readOnly: true,
    hint: "Empty when nothing about this customer was measurable.",
  },
  { name: "healthBand", label: "Band", kind: "badge", readOnly: true, options: BAND_OPTIONS },
  {
    name: "healthTrend",
    label: "Trend",
    kind: "text",
    readOnly: true,
    hint: "Against the last score built from the same inputs. Unknown when there is none.",
  },
  {
    name: "healthCoverage",
    label: "Score coverage",
    kind: "text",
    readOnly: true,
    hint: "How much of the health model had data behind it.",
  },
  { name: "renewalDate", label: "Renews", kind: "date", required: true },
  { name: "termMonths", label: "Term (months)", kind: "number", required: true },
  {
    name: "termSource",
    label: "Term from",
    kind: "text",
    readOnly: true,
    hint: "`default` means nobody stated a term and the platform assumed one.",
  },
  { name: "contractValue", label: "Contract value", kind: "number", required: true },
  { name: "currencyCode", label: "Currency", kind: "text", readOnly: true },
  { name: "startedAt", label: "Started", kind: "date", readOnly: true },
  { name: "originDealId", label: "From deal", kind: "text", readOnly: true },
  { name: "partyId", label: "Party", kind: "text", readOnly: true },
  { name: "signalCount", label: "Signals", kind: "number", readOnly: true },
];

const CONTRACT_SECTION: LifecycleSectionSpec = {
  title: "Contract",
  fields: ["renewalDate", "termMonths", "contractValue"],
};

/**
 * The one description, built once at module load.
 *
 * Served rather than compiled into the client, for the reason `party-layout.ts`
 * records: descriptions belong in data, and the surface reading one should not
 * care whether it came from a constant or a row.
 */
export const CUSTOMER_LIFECYCLE_LAYOUT: LifecycleRecordLayout = {
  key: "crm:customer_lifecycle",
  recordType: "customer_lifecycle",
  singular: "Customer lifecycle",
  plural: "Customer lifecycles",
  titleField: "customerName",
  fields: FIELDS,
  list: {
    searchPlaceholder: "Search customers…",
    columns: [
      { field: "customerName", primary: true, sortable: true, subtitle: "stage" },
      { field: "healthBand", width: "w-28 shrink-0" },
      { field: "healthScore", sortable: true, width: "w-20 shrink-0" },
      { field: "healthTrend", width: "w-28 shrink-0" },
      { field: "renewalDate", sortable: true, width: "w-32 shrink-0" },
    ],
  },
  detail: {
    sections: [
      CONTRACT_SECTION,
      {
        title: "Health",
        fields: ["healthScore", "healthBand", "healthTrend", "healthCoverage"],
      },
      {
        title: "Record",
        fields: [
          "stage",
          "termSource",
          "currencyCode",
          "startedAt",
          "originDealId",
          "partyId",
          "signalCount",
        ],
      },
    ],
  },
  form: { sections: [CONTRACT_SECTION] },
};

/**
 * One row, keyed to the layout above.
 *
 * The type is what enforces the pairing: a field named in a layout section but
 * missing here would render as an empty cell on every row, and the compiler is
 * the only thing that notices before a user does.
 */
export interface CustomerLifecycleRow {
  readonly customerLifecycleId: string;
  readonly customerName: string;
  readonly stage: CustomerLifecycleStage;
  readonly healthScore: number | null;
  readonly healthBand: CustomerHealthBand | null;
  readonly healthTrend: string;
  readonly healthCoverage: string;
  readonly renewalDate: string;
  readonly termMonths: number;
  readonly termSource: string;
  /** Decimal text, the same shape `deals.value` shows. Minor units are storage. */
  readonly contractValue: string;
  readonly currencyCode: string;
  readonly startedAt: string;
  readonly originDealId: string | null;
  readonly partyId: string;
  readonly signalCount: number;
}
