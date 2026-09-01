import { addDec, cmpDec, subDec } from "../../stock-engine/decimal";

/**
 * B1 — is this requirement going to be met, and if not, why not.
 *
 * Pure, and separate from the service, for two reasons. The first is testable
 * arithmetic: the rule has three inputs that move independently (what is held,
 * what is on the shelf, what day it is) and every combination of them is a case
 * somebody has to be able to check. The second is that it is *derived on every
 * read* rather than stored — a stored `atRisk` flag would be wrong the morning
 * after it was written and nothing would say which morning.
 */
export type RiskReason = "SHORT_AND_DUE" | "SHORT_NO_STOCK" | null;

export interface CoverageInput {
  /** What the site asked for. */
  requiredQty: string;
  /** Sum of the line's ACTIVE reservations. Never a stored column — see the service. */
  reservedQty: string;
  /** What has already left for site. */
  fulfilledQty: string;
  /** Availability at the named store, or org-wide when the line names none. */
  availableQty: string;
  /** ISO date (YYYY-MM-DD), or null when the line carries no date. */
  requiredBy: string | null;
  /** Days from ordering to arrival, when the catalogue knows. */
  leadTimeDays: number | null;
}

export interface CoverageAssessment {
  /** required − reserved − fulfilled, floored at zero. What is still unmet. */
  shortfallQty: string;
  atRisk: boolean;
  riskReason: RiskReason;
}

/**
 * `now` is a parameter rather than a `new Date()` inside, so the rule can be
 * tested against a fixed day instead of against whenever the suite happens to
 * run — the class of test that passes for eleven months and fails in December.
 */
export function assessCoverage(input: CoverageInput, now: Date): CoverageAssessment {
  const covered = addDec(input.reservedQty, input.fulfilledQty);
  const rawShort = subDec(input.requiredQty, covered);
  const shortfallQty = cmpDec(rawShort, "0") > 0 ? rawShort : "0";

  if (cmpDec(shortfallQty, "0") <= 0) {
    return { shortfallQty: "0", atRisk: false, riskReason: null };
  }

  // Short, and there is not enough on the shelf to close it. At risk whatever
  // the date says: buying or transferring has to start now, and a line with no
  // date is not therefore a line nobody is waiting on.
  if (cmpDec(input.availableQty, shortfallQty) < 0) {
    return { shortfallQty, atRisk: true, riskReason: "SHORT_NO_STOCK" };
  }

  // Short, stock exists, but nobody has held it and the date is inside the lead
  // time — so if somebody else takes it there is no time to replace it.
  if (input.requiredBy) {
    const due = Date.parse(`${input.requiredBy}T00:00:00Z`);
    if (!Number.isNaN(due)) {
      const leadMs = (input.leadTimeDays ?? 0) * 24 * 60 * 60 * 1000;
      if (due - leadMs <= now.getTime()) {
        return { shortfallQty, atRisk: true, riskReason: "SHORT_AND_DUE" };
      }
    }
  }

  return { shortfallQty, atRisk: false, riskReason: null };
}
