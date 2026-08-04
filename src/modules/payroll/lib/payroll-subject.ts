export type PayrollProfileSubject = {
  userId: string | null;
  workerId: string | null;
};

export function payrollSubjectKey(subject: PayrollProfileSubject): string {
  if (subject.userId) return subject.userId;
  if (subject.workerId) return `worker:${subject.workerId}`;
  throw new Error("Payroll subject requires userId or workerId");
}

export function isWorkerOnlySubject(subject: PayrollProfileSubject): boolean {
  return subject.userId === null && subject.workerId !== null;
}

export function payrollSubjectFromRunEmployee(row: {
  userId: string | null;
  workerId: string | null;
}): PayrollProfileSubject {
  return { userId: row.userId, workerId: row.workerId };
}

export function payrollSubjectKeyFromRunEmployee(row: {
  userId: string | null;
  workerId: string | null;
}): string {
  return payrollSubjectKey(payrollSubjectFromRunEmployee(row));
}
