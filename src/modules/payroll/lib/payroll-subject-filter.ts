import type { PayrollProfileSubject } from "./payroll-subject";

export function matchesPayrollSubjectKey(
  subject: PayrollProfileSubject,
  filterKey: string,
): boolean {
  if (subject.userId && filterKey === subject.userId) return true;
  if (subject.workerId && filterKey === `worker:${subject.workerId}`) return true;
  return false;
}

export function matchesAnyPayrollSubjectKey(
  subject: PayrollProfileSubject,
  filterKeys: string[],
): boolean {
  return filterKeys.some((key) => matchesPayrollSubjectKey(subject, key));
}
