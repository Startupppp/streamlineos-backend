/**
 * The structured CTC behind an offer, computed exactly.
 *
 * A candidate deciding whether to change jobs is comparing our number against
 * someone else's, and `candidate_offers.offered_salary` — one decimal — does
 * not tell them what it is made of. This module is the breakdown: fixed pay,
 * variable, a joining bonus, equity, employer PF and gratuity, with the annual
 * and monthly views a candidate actually reads.
 *
 * MONEY DISCIPLINE. This repository runs two conventions and mixing them is a
 * 100x error: the GL stores integer `*_minor`, HR and timesheets store decimal
 * major. Offers are HR, so every column here is `decimal(15,2)` and postgres-js
 * hands it back as a string — the string IS the exact value, and parsing it to
 * a float is the only lossy step available. This module does not take it. The
 * arithmetic reuses `toPaise` / `fromPaise` from `../staffing/staffing-margin`
 * rather than growing a second, subtly different parser beside them: one
 * decimal-to-paise implementation for the whole of recruitment is the point,
 * and a fork of it is how the two would drift apart.
 *
 * The float this replaces is not theoretical. A breakdown of 1250000.10 +
 * 312500.07 + 50000.03 sums to 1612500.2000000002 in binary floating point,
 * and `.toFixed(2)` hides that rather than fixing it — leaving a total that
 * disagrees with `offered_salary` by a rounding nobody chose, on the one screen
 * where a candidate is checking exactly that.
 *
 * SAFE-INTEGER HEADROOM. `decimal(15,2)` holds at most 13 whole digits, so one
 * component is at most 1e15 paise and the six-component total at most 6e15 —
 * both inside `Number.MAX_SAFE_INTEGER` (9.007e15), so every sum below is
 * exact rather than merely close.
 */

import { fromPaise, toPaise } from "../staffing/staffing-margin";

export const CTC_COMPONENT_KEYS = [
  "fixed",
  "variable",
  "joiningBonus",
  "equityValue",
  "employerPf",
  "gratuity",
] as const;

export type CtcComponentKey = (typeof CTC_COMPONENT_KEYS)[number];

/**
 * Every component is nullable, and null is load-bearing.
 *
 * A zero variable and an unentered variable are different facts. "This role has
 * no performance bonus" is a term of the offer and belongs on the page; "nobody
 * has filled the variable in yet" is an unfinished draft. Collapsing the two —
 * defaulting a missing component to zero — publishes a claim the company never
 * made, to the person deciding on it.
 */
export type CtcBreakdown = { readonly [K in CtcComponentKey]: string | null };

/**
 * Whether dividing the component by twelve tells the candidate something true.
 *
 * A joining bonus is paid once; rendering it as "₹4,166.67/month" states a
 * recurring payment that does not exist. Equity is a vesting value, not cash in
 * a bank account, and a monthly figure against it reads as salary. Both are
 * therefore held out of the monthly column and out of the monthly total, and
 * shown as what they are.
 */
export type CtcRecurrence = "MONTHLY" | "LUMP_SUM";

interface ComponentSpec {
  readonly label: string;
  readonly recurrence: CtcRecurrence;
}

/** Fixed reading order: the components a candidate scans top-down, cash first. */
const COMPONENT_SPECS: Record<CtcComponentKey, ComponentSpec> = {
  fixed: { label: "Fixed pay", recurrence: "MONTHLY" },
  variable: { label: "Variable / performance pay", recurrence: "MONTHLY" },
  employerPf: { label: "Employer PF contribution", recurrence: "MONTHLY" },
  gratuity: { label: "Gratuity", recurrence: "MONTHLY" },
  joiningBonus: { label: "Joining bonus (one-time)", recurrence: "LUMP_SUM" },
  equityValue: { label: "Equity (annual vesting value)", recurrence: "LUMP_SUM" },
};

const READING_ORDER: readonly CtcComponentKey[] = [
  "fixed",
  "variable",
  "employerPf",
  "gratuity",
  "joiningBonus",
  "equityValue",
];

const MONTHS_PER_YEAR = 12;

/**
 * `toPaise` is written for the column and calls `.trim()`, so it assumes the
 * string postgres-js returns for `numeric`. This narrows before that, because
 * the one screen these numbers reach is a public, unauthenticated offer page: a
 * value that is not a string — a hand-built fixture, a JSON body, a row read
 * through a client that coerces — must become an unparseable component, which
 * `malformed` reports, and never a TypeError that takes the page down while a
 * candidate is trying to accept a job.
 */
function parseAmount(value: string | null | undefined): number | null {
  return typeof value === "string" ? toPaise(value) : null;
}

/**
 * Annual paise into a monthly figure, half-up to the paisa, in integers only.
 *
 * `Math.round(annualPaise / 12)` would do the division in binary floating point
 * and then round a value that is already wrong. `%` is exact on safe integers,
 * and `annualPaise - remainder` is an exact multiple of twelve, so the division
 * that follows is exact too. Half-up is applied to the magnitude so a negative
 * mirrors its positive rather than drifting toward zero.
 */
function dividePaiseIntoMonths(annualPaise: number): number {
  const remainder = annualPaise % MONTHS_PER_YEAR;
  const whole = (annualPaise - remainder) / MONTHS_PER_YEAR;
  const bump = Math.abs(remainder) * 2 >= MONTHS_PER_YEAR ? Math.sign(remainder) : 0;
  return whole + bump;
}

export interface CtcPreviewLine {
  key: CtcComponentKey;
  label: string;
  recurrence: CtcRecurrence;
  /** The annual amount, exactly as the column holds it. */
  annual: string;
  /** Annual ÷ 12. Null for a lump sum, which has no monthly form. */
  monthly: string | null;
}

export type CtcReconciliationStatus = "MATCHED" | "MISMATCHED" | "NOT_COMPARABLE";

export interface CtcReconciliation {
  status: CtcReconciliationStatus;
  /** Breakdown total minus `offered_salary`, exact. Null unless comparable. */
  difference: string | null;
  /** What disagrees, or why the two cannot be compared. Null when matched. */
  message: string | null;
}

export interface CtcPreview {
  /** One line per component somebody entered, in reading order. */
  lines: CtcPreviewLine[];
  /** Sum of every entered component. Null when nothing was entered. */
  annualTotal: string | null;
  /** Sum of the monthly lines above, so the rendered column adds up. */
  monthlyTotal: string | null;
  /** Sum of the lump sums, deliberately outside the monthly figure. */
  lumpSumTotal: string | null;
  /**
   * Components supplied in a shape the column cannot hold. Always empty for a
   * row read out of `candidate_offers`; non-empty means a caller passed
   * something the total therefore does NOT include, which is worth saying out
   * loud rather than absorbing as a zero.
   */
  malformed: CtcComponentKey[];
  reconciliation: CtcReconciliation;
}

/**
 * The sum of the components that were entered, as a `decimal(15,2)` string.
 *
 * Null when the breakdown is empty — no component entered at all. That is not a
 * CTC of zero, it is an offer with no breakdown on it, and the two must not
 * render the same.
 */
export function totalCtc(breakdown: CtcBreakdown): string | null {
  let totalPaise = 0;
  let entered = 0;

  for (const key of CTC_COMPONENT_KEYS) {
    const paise = parseAmount(breakdown[key]);
    if (paise === null) continue;
    totalPaise += paise;
    entered += 1;
  }

  return entered === 0 ? null : fromPaise(totalPaise);
}

/**
 * Does the breakdown add up to the `offered_salary` the rest of the system
 * already acts on?
 *
 * `offered_salary` is live: the handoff builds a salary structure from it, the
 * negotiation flow counters against it, and the offer letter quotes it. The
 * breakdown is additive beside it, not a replacement, so the two have to agree
 * or the candidate is reading one number while payroll is reading another. This
 * returns the verdict rather than throwing it — the caller decides whether a
 * disagreement is a 400 or a warning, and a pure function that throws cannot be
 * used to render the very screen that would show the problem.
 */
export function reconcileCtcAgainstOfferedSalary(
  breakdown: CtcBreakdown,
  offeredSalary: string | null | undefined,
): CtcReconciliation {
  const breakdownTotal = totalCtc(breakdown);
  const offeredPaise = parseAmount(offeredSalary);

  if (breakdownTotal === null) {
    return {
      status: "NOT_COMPARABLE",
      difference: null,
      message: "No compensation breakdown has been entered on this offer.",
    };
  }
  if (offeredPaise === null) {
    return {
      status: "NOT_COMPARABLE",
      difference: null,
      message: "This offer carries no offered salary to reconcile the breakdown against.",
    };
  }

  const differencePaise = (parseAmount(breakdownTotal) ?? 0) - offeredPaise;
  if (differencePaise === 0) {
    return { status: "MATCHED", difference: "0.00", message: null };
  }

  return {
    status: "MISMATCHED",
    difference: fromPaise(differencePaise),
    message:
      `The compensation breakdown totals ${breakdownTotal}, but the offered salary is ` +
      `${fromPaise(offeredPaise)} — a difference of ${fromPaise(differencePaise)}. ` +
      "Adjust a component or the offered salary so the two agree.",
  };
}

/**
 * The annual and monthly view, ready to render.
 *
 * `monthlyTotal` is the sum of the per-line monthly figures rather than a
 * separate division of the annual total. Rounding each line and then rounding
 * the total independently produces a column that does not add up to its own
 * footer, on a page whose entire purpose is that a candidate can check the
 * arithmetic.
 */
export function buildCtcPreview(
  breakdown: CtcBreakdown,
  offeredSalary: string | null | undefined,
): CtcPreview {
  const lines: CtcPreviewLine[] = [];
  const malformed: CtcComponentKey[] = [];
  let annualTotalPaise = 0;
  let monthlyTotalPaise = 0;
  let lumpSumTotalPaise = 0;
  let monthlyLines = 0;
  let lumpSumLines = 0;

  for (const key of READING_ORDER) {
    const raw = breakdown[key];
    const annualPaise = parseAmount(raw);
    if (annualPaise === null) {
      if (raw !== null && raw !== undefined) malformed.push(key);
      continue;
    }

    const spec = COMPONENT_SPECS[key];
    annualTotalPaise += annualPaise;

    if (spec.recurrence === "LUMP_SUM") {
      lumpSumTotalPaise += annualPaise;
      lumpSumLines += 1;
      lines.push({
        key,
        label: spec.label,
        recurrence: spec.recurrence,
        annual: fromPaise(annualPaise),
        monthly: null,
      });
      continue;
    }

    const monthlyPaise = dividePaiseIntoMonths(annualPaise);
    monthlyTotalPaise += monthlyPaise;
    monthlyLines += 1;
    lines.push({
      key,
      label: spec.label,
      recurrence: spec.recurrence,
      annual: fromPaise(annualPaise),
      monthly: fromPaise(monthlyPaise),
    });
  }

  return {
    lines,
    annualTotal: lines.length === 0 ? null : fromPaise(annualTotalPaise),
    monthlyTotal: monthlyLines === 0 ? null : fromPaise(monthlyTotalPaise),
    lumpSumTotal: lumpSumLines === 0 ? null : fromPaise(lumpSumTotalPaise),
    malformed,
    reconciliation: reconcileCtcAgainstOfferedSalary(breakdown, offeredSalary),
  };
}
