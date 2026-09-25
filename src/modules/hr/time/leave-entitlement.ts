/**
 * HRMS-E2E-014. Configuring a 12-day Casual Leave policy left every balance
 * view saying "No leave policy is set up yet, so nothing has accrued" and
 * Available Days 0.
 *
 * `LeavesService.balance` reads stored `leave_balances` rows and nothing else,
 * and nothing creates one when a leave type is configured. So a fresh
 * organisation has types and no balances, which the UI reads — correctly, from
 * what it was given — as "no policy". The dashboard widget disagreed and showed
 * 12 / 12 because it derives from the type's `daysPerYear` instead: two sources,
 * two answers, for the same person on the same day.
 *
 * Worse, it is not only cosmetic. `LeavesApprovalService` deducts only
 * `if (balanceRecord)`, so with no row an approval silently subtracts nothing
 * and writes no ledger entry. That is why the audit could not verify a
 * deduction: there was nothing to deduct from.
 *
 * This is the read half. A leave type's `daysPerYear` is the opening
 * entitlement, so a type with no stored row for this person and year reports
 * that entitlement rather than being omitted. Once a row exists — the approval
 * path creates one before it deducts — the stored row is the authority and the
 * entitlement is not consulted again.
 *
 * Deliberately a pure function over rows already fetched: `balance()` is a read
 * behind a GET, and BE-33 forbids writing there. The row is created on the
 * write path, where it belongs.
 */

/** A configured leave type. `daysPerYear` 0 means unpaid, which has no entitlement to open. */
export interface LeaveTypeEntitlement {
  id: number;
  name: string;
  daysPerYear: number;
}

/** A stored balance row, already filtered to one person and year. */
export interface StoredLeaveBalance {
  leaveTypeId: number;
  balance: string;
}

export interface ResolvedLeaveBalance {
  leaveTypeId: number;
  balance: string;
  /** True when no row is stored yet and this is the type's opening entitlement. */
  isOpeningEntitlement: boolean;
}

/**
 * Every configured type, carrying the stored balance where one exists and the
 * type's opening entitlement where one does not.
 *
 * Types are the outer loop on purpose. Driving from the stored rows is what
 * produced the empty list: a policy nobody has consumed yet has no row, and so
 * disappeared from a screen whose whole job is to say it exists.
 */
export function resolveLeaveBalances(
  types: readonly LeaveTypeEntitlement[],
  stored: readonly StoredLeaveBalance[],
): ResolvedLeaveBalance[] {
  const byType = new Map(stored.map((row) => [row.leaveTypeId, row]));
  return types.map((type) => {
    const row = byType.get(type.id);
    if (row !== undefined)
      return { leaveTypeId: type.id, balance: row.balance, isOpeningEntitlement: false };
    return {
      leaveTypeId: type.id,
      balance: openingEntitlementOf(type),
      isOpeningEntitlement: true,
    };
  });
}

/**
 * The opening balance a type grants before anything is consumed.
 *
 * Stored as a decimal string, matching `leave_balances.balance`, so a caller
 * never has to know which of the two it is holding.
 */
export function openingEntitlementOf(type: LeaveTypeEntitlement): string {
  const days = Number.isFinite(type.daysPerYear) ? Math.max(0, type.daysPerYear) : 0;
  return days.toFixed(2);
}

/**
 * True when the organisation has configured nothing, which is the only state
 * that may say so on screen.
 *
 * The distinction this ticket turns on: no *types* means no policy; no *rows*
 * means nobody has consumed any leave yet, which is the ordinary state of a
 * freshly configured organisation and must not be reported as an absent policy.
 */
export function hasNoLeavePolicy(types: readonly LeaveTypeEntitlement[]): boolean {
  return types.length === 0;
}
