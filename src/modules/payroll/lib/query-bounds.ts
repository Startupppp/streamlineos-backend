import { ConflictException } from "@nestjs/common";

/**
 * Payroll workflows need complete run-scoped sets, but must not issue an
 * unbounded read. The extra probe row makes an unexpectedly large set fail
 * visibly instead of being silently truncated.
 */
export const PAYROLL_READ_CAP = 1000;

/**
 * The ceiling on one journal batch's line count, derived rather than chosen.
 *
 * `JournalService.buildJournal` emits one line per
 * (componentId, code, category, costCenter) group — capped at
 * `PAYROLL_READ_CAP` groups — plus a contra line for each employer-contribution
 * group, plus the single "Salaries Payable" credit. So a batch the service can
 * legally produce holds at most `2 × cap + 1` lines, and any read of
 * `payroll_journal_batch_lines` bounded lower than this truncates a batch the
 * system itself created.
 */
export const PAYROLL_JOURNAL_BATCH_LINE_CAP = PAYROLL_READ_CAP * 2 + 1;

export function requirePayrollReadWithinCap<T>(
  rows: T[],
  operation: string,
  cap: number = PAYROLL_READ_CAP,
): T[] {
  if (rows.length > cap) {
    throw new ConflictException(
      `${operation} exceeds the supported ${cap}-row payroll read bound`,
    );
  }
  return rows;
}
