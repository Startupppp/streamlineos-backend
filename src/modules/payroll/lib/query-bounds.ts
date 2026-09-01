import { ConflictException } from "@nestjs/common";

/**
 * Payroll workflows need complete run-scoped sets, but must not issue an
 * unbounded read. The extra probe row makes an unexpectedly large set fail
 * visibly instead of being silently truncated.
 */
export const PAYROLL_READ_CAP = 1000;

export function requirePayrollReadWithinCap<T>(rows: T[], operation: string): T[] {
  if (rows.length > PAYROLL_READ_CAP) {
    throw new ConflictException(
      `${operation} exceeds the supported ${PAYROLL_READ_CAP}-row payroll read bound`,
    );
  }
  return rows;
}
