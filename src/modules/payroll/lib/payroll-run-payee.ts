import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRunEmployees,
  users,
  workers,
  organizationPeople,
} from "../../../db/schema";
import {
  hrPeople,
  hrEmployments,
  hrEmployeeSensitiveFields,
} from "../../../db/schema/hr/core-people";
import { decryptBankDetails, type BankDetails } from "../hr-payroll/lib/encryption";
import {
  payrollSubjectFromRunEmployee,
  payrollSubjectKeyFromRunEmployee,
} from "./payroll-subject";
import type { PayrollProfileSubject } from "./payroll-subject";

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
  workerNumber: string | null;
};

const linkedPersonUser = alias(users, "payroll_payee_linked_user");

function personName(row: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const composed = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  return row.displayName?.trim() || composed || "Payee";
}

function bankFromSensitive(
  sensitiveBank: typeof hrEmployeeSensitiveFields.$inferSelect["bankDetails"] | null | undefined,
): DecryptedBankDetails {
  if (!sensitiveBank || typeof sensitiveBank !== "object") return null;
  const accountNumber = sensitiveBank.accountNumber?.trim();
  if (!accountNumber) return null;
  return {
    accountNumber,
    bankName: sensitiveBank.bankName ?? "",
    branch: sensitiveBank.branch ?? "",
    ifsc: sensitiveBank.ifsc ?? "",
    accountHolder: sensitiveBank.accountHolder ?? "",
    pfUanNumber: sensitiveBank.pfUanNumber,
    esiIpNumber: sensitiveBank.esiIpNumber,
  };
}

function pickBank(
  userBank: string | null | undefined,
  linkedUserBank: string | null | undefined,
  sensitiveBank: typeof hrEmployeeSensitiveFields.$inferSelect["bankDetails"] | null | undefined,
): DecryptedBankDetails {
  const fromUser = decryptBankDetails(userBank ?? null);
  if (fromUser?.accountNumber) return fromUser;
  const fromLinked = decryptBankDetails(linkedUserBank ?? null);
  if (fromLinked?.accountNumber) return fromLinked;
  return bankFromSensitive(sensitiveBank);
}

export async function loadRunEmployeePayees(
  db: Db,
  orgId: string,
  runId: number,
): Promise<PayrollPayeeDetails[]> {
  const rows = await db
    .select({
      id: payrollRunEmployees.id,
      userId: payrollRunEmployees.userId,
      workerId: payrollRunEmployees.workerId,
      userName: users.name,
      userEmail: users.email,
      userEmployeeId: users.employeeId,
      userDesignation: users.designation,
      userJoiningDate: users.joiningDate,
      userBankDetails: users.bankDetails,
      workerNumber: workers.workerNumber,
      personDisplayName: organizationPeople.displayName,
      personFirstName: organizationPeople.firstName,
      personLastName: organizationPeople.lastName,
      personWorkEmail: organizationPeople.workEmail,
      linkedUserBankDetails: linkedPersonUser.bankDetails,
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
    .leftJoin(linkedPersonUser, eq(linkedPersonUser.id, organizationPeople.userId))
    .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

  const workerOnlyEmails = rows
    .filter((row) => !row.userId && row.workerId && row.personWorkEmail)
    .map((row) => row.personWorkEmail as string);

  const sensitiveByEmail = new Map<string, { bankDetails: typeof hrEmployeeSensitiveFields.$inferSelect["bankDetails"] }>();

  if (workerOnlyEmails.length > 0) {
    const sensitiveRows = await db
      .select({
        workEmail: hrPeople.workEmail,
        panNumber: hrEmployeeSensitiveFields.panNumber,
        bankDetails: hrEmployeeSensitiveFields.bankDetails,
      })
      .from(hrEmployeeSensitiveFields)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeSensitiveFields.employmentId))
      .innerJoin(hrPeople, eq(hrPeople.id, hrEmployments.personId))
      .where(
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployments.isPrimary, true),
          inArray(hrPeople.workEmail, workerOnlyEmails),
        ),
      );

    for (const row of sensitiveRows) {
      sensitiveByEmail.set(row.workEmail, { bankDetails: row.bankDetails });
    }
  }

  return rows.map((row) => {
    const subject = payrollSubjectFromRunEmployee(row);
    const sens =
      !row.userId && row.personWorkEmail
        ? sensitiveByEmail.get(row.personWorkEmail)
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
      employeeId: row.userEmployeeId ?? row.workerNumber ?? null,
      designation: row.userDesignation ?? null,
      joiningDate: row.userJoiningDate ?? null,
      bankDetails: pickBank(row.userBankDetails, row.linkedUserBankDetails, sens?.bankDetails),
      workerNumber: row.workerNumber ?? null,
    };
  });
}

export async function loadRunEmployeePayeeById(
  db: Db,
  orgId: string,
  runEmployeeId: number,
): Promise<PayrollPayeeDetails | null> {
  const runRow = await db.query.payrollRunEmployees.findFirst({
    where: and(eq(payrollRunEmployees.id, runEmployeeId), eq(payrollRunEmployees.orgId, orgId)),
    columns: { runId: true },
  });
  if (!runRow) return null;
  const payees = await loadRunEmployeePayees(db, orgId, runRow.runId);
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
