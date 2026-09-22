import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { payrollRunEmployees, users } from "../../../db/schema";
import {
  payrollSubjectFromRunEmployee,
  payrollSubjectKeyFromRunEmployee,
} from "./payroll-subject";
import type { PayrollProfileSubject } from "./payroll-subject";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { BankDetails } from "../../directory/employment-facts.types";
import { readPayrollKeysetBatches } from "./payroll-keyset-batch";
import {
  resolvePeopleIdentities,
  subjectKey,
  type PersonSubject,
} from "../../directory/person-seam";

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
  const composed = [row.firstName, row.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return row.displayName?.trim() || composed || "Payee";
}

export async function loadRunEmployeePayees(
  db: Db,
  orgId: string,
  runId: number,
  efService: EmploymentFactsService,
): Promise<PayrollPayeeDetails[]> {
  const rows = await readPayrollKeysetBatches({
    fetch: (afterId, limit) =>
      db
        .select({
          userName: users.name,
          userEmail: users.email,
          id: payrollRunEmployees.id,
          userId: payrollRunEmployees.userId,
          workerId: payrollRunEmployees.workerId,
        })
        .from(payrollRunEmployees)
        .leftJoin(users, eq(payrollRunEmployees.userId, users.id))
        .where(
          and(
            eq(payrollRunEmployees.runId, runId),
            eq(payrollRunEmployees.orgId, orgId),
            ...(afterId === null ? [] : [gt(payrollRunEmployees.id, afterId)]),
          ),
        )
        .orderBy(asc(payrollRunEmployees.id))
        .limit(limit),
    idOf: (row) => row.id,
  });

  const subjects: PersonSubject[] = rows.flatMap((r): PersonSubject[] => {
    if (r.userId !== null) return [{ kind: "user", userId: r.userId }];
    if (r.workerId !== null) return [{ kind: "worker", workerId: r.workerId }];
    return [];
  });

  const identities = await resolvePeopleIdentities(db, orgId, subjects);

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
          (r): r is typeof r & { workerId: string } =>
            r.userId === null && r.workerId !== null,
        )
        .flatMap((r) => {
          const identity = identities.get(
            subjectKey({ kind: "worker", workerId: r.workerId }),
          );
          return identity?.organizationPersonId
            ? [identity.organizationPersonId]
            : [];
        }),
    ),
  ];

  const [factsMap, sensitiveMap, personSensitiveMap] = await Promise.all([
    efService.getFactsBatch(orgId, userIds),
    efService.getSensitiveFactsBatch(orgId, userIds),
    efService.getSensitiveFactsByPersonBatch(orgId, personIds),
  ]);

  return rows.map((row) => {
    const subject = payrollSubjectFromRunEmployee(row);
    const identity =
      row.userId !== null
        ? identities.get(subjectKey({ kind: "user", userId: row.userId }))
        : row.workerId !== null
          ? identities.get(
              subjectKey({ kind: "worker", workerId: row.workerId }),
            )
          : undefined;
    const facts = row.userId !== null ? factsMap.get(row.userId) : undefined;
    const sensitive =
      row.userId !== null
        ? sensitiveMap.get(row.userId)
        : identity?.organizationPersonId
          ? personSensitiveMap.get(identity.organizationPersonId)
          : undefined;

    const displayName =
      row.userName ??
      (identity != null
        ? personName({
            displayName: identity.displayName,
            firstName: identity.firstName,
            lastName: identity.lastName,
          })
        : "Payee");

    return {
      runEmployeeId: row.id,
      subject,
      subjectKey: payrollSubjectKeyFromRunEmployee(row),
      displayName,
      email: row.userEmail ?? identity?.workEmail ?? null,
      employeeId: facts?.employeeNumber ?? identity?.workerNumber ?? null,
      designation: facts?.designation ?? null,
      joiningDate: facts?.joiningDate ?? null,
      bankDetails: sensitive?.bankDetails ?? null,
      taxId: sensitive?.taxId ?? null,
      panNumber: sensitive?.panNumber ?? null,
      workerNumber: identity?.workerNumber ?? null,
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
    where: and(
      eq(payrollRunEmployees.id, runEmployeeId),
      eq(payrollRunEmployees.orgId, orgId),
    ),
    columns: { runId: true },
  });
  if (!runRow) return null;
  const payees = await loadRunEmployeePayees(
    db,
    orgId,
    runRow.runId,
    efService,
  );
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
        (payee.subject.workerId != null &&
          key === `worker:${payee.subject.workerId}`),
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
