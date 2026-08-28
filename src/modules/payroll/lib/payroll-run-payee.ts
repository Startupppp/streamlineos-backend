import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRunEmployees,
  users,
  workers,
  organizationPeople,
} from "../../../db/schema";
import {
  payrollSubjectFromRunEmployee,
  payrollSubjectKeyFromRunEmployee,
} from "./payroll-subject";
import type { PayrollProfileSubject } from "./payroll-subject";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { BankDetails } from "../../directory/employment-facts.types";

export type { PayrollProfileSubject };

export type DecryptedBankDetails = BankDetails | null;

export type PayrollPayeeDetails = {
  runEmployeeId: number;
  subject: PayrollProfileSubject;
  subjectKey: string;
  displayName: string;
  email: string | null;
  employeeId: string | null;
  designation: string | null;
  joiningDate: string | null;
  bankDetails: DecryptedBankDetails;
  taxId: string | null;
  panNumber: string | null;
  workerNumber: string | null;
};

function personName(row: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const composed = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  return row.displayName?.trim() || composed || "Payee";
}

export async function loadRunEmployeePayees(
  db: Db,
  orgId: string,
  runId: number,
  efService: EmploymentFactsService,
): Promise<PayrollPayeeDetails[]> {
  const rows = await db
    .select({
      id: payrollRunEmployees.id,
      userId: payrollRunEmployees.userId,
      workerId: payrollRunEmployees.workerId,
      userName: users.name,
      userEmail: users.email,
      workerNumber: workers.workerNumber,
      personDisplayName: organizationPeople.displayName,
      personFirstName: organizationPeople.firstName,
      personLastName: organizationPeople.lastName,
      personWorkEmail: organizationPeople.workEmail,
      organizationPersonId: workers.organizationPersonId,
    })
    .from(payrollRunEmployees)
    .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
    .leftJoin(
      workers,
      and(
        eq(workers.workerId, payrollRunEmployees.workerId),
        eq(workers.organizationId, payrollRunEmployees.orgId),
      ),
    )
    .leftJoin(
      organizationPeople,
      and(
        eq(organizationPeople.organizationPersonId, workers.organizationPersonId),
        eq(organizationPeople.organizationId, workers.organizationId),
      ),
    )
    .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

  const userIds = [
    ...new Set(
      rows
        .filter((r): r is typeof r & { userId: string } => r.userId !== null)
        .map((r) => r.userId),
    ),
  ];

  const personIds = [
    ...new Set(
      rows
        .filter(
          (r): r is typeof r & { organizationPersonId: string } =>
            r.userId === null && r.organizationPersonId !== null,
        )
        .map((r) => r.organizationPersonId),
    ),
  ];

  const [factsMap, sensitiveMap, personSensitiveMap] = await Promise.all([
    efService.getFactsBatch(orgId, userIds),
    efService.getSensitiveFactsBatch(orgId, userIds),
    efService.getSensitiveFactsByPersonBatch(orgId, personIds),
  ]);

  return rows.map((row) => {
    const subject = payrollSubjectFromRunEmployee(row);
    const facts = row.userId !== null ? factsMap.get(row.userId) : undefined;
    const sensitive =
      row.userId !== null
        ? sensitiveMap.get(row.userId)
        : row.organizationPersonId !== null
          ? personSensitiveMap.get(row.organizationPersonId)
          : undefined;

    const displayName =
      row.userName ??
      (row.personFirstName != null
        ? personName({
            displayName: row.personDisplayName,
            firstName: row.personFirstName,
            lastName: row.personLastName,
          })
        : "Payee");

    return {
      runEmployeeId: row.id,
      subject,
      subjectKey: payrollSubjectKeyFromRunEmployee(row),
      displayName,
      email: row.userEmail ?? row.personWorkEmail ?? null,
      employeeId: facts?.employeeNumber ?? row.workerNumber ?? null,
      designation: facts?.designation ?? null,
      joiningDate: facts?.joiningDate ?? null,
      bankDetails: sensitive?.bankDetails ?? null,
      taxId: sensitive?.taxId ?? null,
      panNumber: sensitive?.panNumber ?? null,
      workerNumber: row.workerNumber ?? null,
    };
  });
}

export async function loadRunEmployeePayeeById(
  db: Db,
  orgId: string,
  runEmployeeId: number,
  efService: EmploymentFactsService,
): Promise<PayrollPayeeDetails | null> {
  const runRow = await db.query.payrollRunEmployees.findFirst({
    where: and(eq(payrollRunEmployees.id, runEmployeeId), eq(payrollRunEmployees.orgId, orgId)),
    columns: { runId: true },
  });
  if (!runRow) return null;
  const payees = await loadRunEmployeePayees(db, orgId, runRow.runId, efService);
  return payees.find((payee) => payee.runEmployeeId === runEmployeeId) ?? null;
}

export function filterPayeesBySubjectKeys(
  payees: PayrollPayeeDetails[],
  subjectKeys: string[],
): PayrollPayeeDetails[] {
  if (subjectKeys.length === 0) return payees;
  return payees.filter((payee) =>
    subjectKeys.some(
      (key) =>
        (payee.subject.userId != null && key === payee.subject.userId) ||
        (payee.subject.workerId != null && key === `worker:${payee.subject.workerId}`),
    ),
  );
}

export function filterPayeesByRunEmployeeIds(
  payees: PayrollPayeeDetails[],
  runEmployeeIds: number[],
): PayrollPayeeDetails[] {
  if (runEmployeeIds.length === 0) return payees;
  const idSet = new Set(runEmployeeIds);
  return payees.filter((payee) => idSet.has(payee.runEmployeeId));
}
