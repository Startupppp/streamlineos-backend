import { BadRequestException } from "@nestjs/common";
import {
  buildCtcPreview,
  reconcileCtcAgainstOfferedSalary,
  type CtcBreakdown,
  type CtcPreview,
} from "./ctc-breakdown";

/**
 * The glue between `candidate_offers`' six CTC columns and the pure arithmetic
 * in `ctc-breakdown.ts`. It exists so the offers service stays a service: the
 * money rules live in one file that knows nothing about Nest or Drizzle, and
 * the column names live here.
 */

export const CTC_INPUT_KEYS = [
  "ctcFixed",
  "ctcVariable",
  "ctcJoiningBonus",
  "ctcEquityValue",
  "ctcEmployerPf",
  "ctcGratuity",
] as const;

export type CtcInputKey = (typeof CTC_INPUT_KEYS)[number];

/** What a client may send, and what the row stores, keyed the same way. */
export type CtcBreakdownInput = Partial<Record<CtcInputKey, number>>;
export type CtcColumns = Partial<Record<CtcInputKey, string | null>>;

/**
 * A JSON number into the exact `decimal(15,2)` string the column will hold.
 *
 * `String(n)` is not enough. A client that computed its total in JavaScript
 * sends 1612500.2000000002, `String` preserves every one of those digits, and
 * `toPaise` — which refuses anything wider than the column — reads it as absent
 * and drops it from the total. `toFixed(2)` applies exactly the rounding
 * Postgres would apply on the way in, so the value this module reconciles is
 * the value the row ends up holding, not a near neighbour of it.
 */
export function toDecimalColumn(value: number): string {
  return value.toFixed(2);
}

/** Only the components the caller actually sent; an absent one stays absent. */
export function ctcColumnValues(input: CtcBreakdownInput): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of CTC_INPUT_KEYS) {
    const value = input[key];
    if (value !== undefined) values[key] = toDecimalColumn(value);
  }
  return values;
}

/**
 * Every compensation column an offer-creation payload sets, reconciled.
 *
 * Creation is one atomic payload, so a breakdown that disagrees with the salary
 * in the same request is a caught error and not a half-typed draft — nothing
 * here can block a recruiter mid-edit the way the same check inside a PATCH
 * would. A payload carrying only one of the two sides reconciles as
 * NOT_COMPARABLE and passes through untouched.
 */
export function offerCompensationColumns(
  input: CtcBreakdownInput & { offeredSalary?: number },
): Record<string, string> {
  const columns = ctcColumnValues(input);
  if (input.offeredSalary !== undefined) columns.offeredSalary = toDecimalColumn(input.offeredSalary);
  assertCtcReconciles(columns, columns.offeredSalary);
  return columns;
}

/** The stored columns in the shape the pure module reads. */
export function breakdownFromColumns(row: CtcColumns): CtcBreakdown {
  return {
    fixed: row.ctcFixed ?? null,
    variable: row.ctcVariable ?? null,
    joiningBonus: row.ctcJoiningBonus ?? null,
    equityValue: row.ctcEquityValue ?? null,
    employerPf: row.ctcEmployerPf ?? null,
    gratuity: row.ctcGratuity ?? null,
  };
}

/**
 * Attach the rendered annual/monthly view to a row on its way to a client.
 *
 * Computed here and never in the browser. A second money implementation on the
 * frontend — parsing these decimals into floats to add them up — is exactly the
 * 100x-class error this module exists to prevent, and it would put the total a
 * candidate reads out of step with the total the guard checks.
 */
export function withCtcPreview<T extends CtcColumns & { offeredSalary: string | null }>(
  row: T,
): T & { ctcPreview: CtcPreview } {
  return { ...row, ctcPreview: buildCtcPreview(breakdownFromColumns(row), row.offeredSalary) };
}

/** The breakdown minus everything only a recruiter should read. */
export type CandidateFacingCtcPreview = Omit<CtcPreview, "reconciliation" | "malformed">;

/**
 * The preview a candidate may see on the public offer page.
 *
 * Two things are withheld. The reconciliation verdict is recruiter-facing — its
 * message tells somebody to go and adjust a component, which is not an
 * instruction for the person being hired. And when the breakdown does NOT add up
 * to `offered_salary`, the candidate gets no breakdown at all rather than two
 * disagreeing numbers on the same screen: the approval guard means a properly
 * sent offer cannot reach this state, so the fallback is for offers patched
 * around it, and silence beats a contradiction on the page someone accepts a job
 * from.
 */
export function candidateFacingCtcPreview(
  row: CtcColumns,
  offeredSalary: string | null,
): CandidateFacingCtcPreview | null {
  const { reconciliation, malformed, ...visible } = buildCtcPreview(
    breakdownFromColumns(row),
    offeredSalary,
  );
  if (visible.lines.length === 0) return null;
  if (reconciliation.status === "MISMATCHED" || malformed.length > 0) return null;
  return visible;
}

/**
 * Refuse a breakdown that does not add up to `offered_salary`.
 *
 * Deliberately silent when either side is missing. A recruiter part-way through
 * a draft has a salary and no breakdown, or a first component and no salary
 * yet, and 400-ing that makes the screen unsavable — a backend validation whose
 * frontend half does not exist is how a form becomes impossible to submit. The
 * mismatch that matters is the one still standing when the offer is sent, which
 * is where the callers of this put it.
 */
export function assertCtcReconciles(row: CtcColumns, offeredSalary: string | null | undefined): void {
  const verdict = reconcileCtcAgainstOfferedSalary(breakdownFromColumns(row), offeredSalary);
  if (verdict.status === "MISMATCHED" && verdict.message) {
    throw new BadRequestException(verdict.message);
  }
}
