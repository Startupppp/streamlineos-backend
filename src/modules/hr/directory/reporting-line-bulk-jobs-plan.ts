import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { ScopedRead } from "../../access/scoped-read";
import type { hrReportingLineBulkJobRows, ReportingLineBulkRowStatus } from "../../../db/schema";
import { REPORTING_LINE_ERROR_CODES as CODES, type RelationshipValidation } from "../../directory/reporting-line.types";
import { findManagerCycles } from "./bulk-onboarding/bulk-onboarding-graph";
import { peopleByEmails, peopleByUserIds, visibleUserIds, type PersonRef } from "./reporting-manager-people";
import type { CreateBulkJobInput } from "./dto/reporting-lines-bulk.schemas";

export interface PlannedRow {
  rowNumber: number;
  employeeEmail: string;
  employee: PersonRef | undefined;
  primaryManagerEmail: string | null;
  primaryManager: PersonRef | undefined;
  secondaryEmails: string[];
  secondary: Array<PersonRef | undefined>;
  effectiveFrom: string;
  reason: string | null;
  issues: Array<{ code: string; message: string }>;
}

function meaningful(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function classifyBulkRow(
  row: PlannedRow,
  validation: RelationshipValidation | undefined,
  currentOf: Map<number, { managerEmploymentId: number }>,
): Omit<typeof hrReportingLineBulkJobRows.$inferInsert, "orgId" | "jobId"> {
  const needsReasonOnly = validation?.issues.every((issue) => issue.code === CODES.CHANGE_REASON_REQUIRED) ?? false;
  const issues = [...row.issues, ...(validation && !needsReasonOnly ? validation.issues : [])];
  const warnings = validation?.warnings ?? [];
  const reasonCodes = validation && !validation.ok && needsReasonOnly ? [CODES.CHANGE_REASON_REQUIRED] : [];
  const status: ReportingLineBulkRowStatus =
    issues.length > 0 ? "ERROR" : warnings.length > 0 || reasonCodes.length > 0 ? "WARNING" : "READY";
  const codes = [...new Set([...issues.map((issue) => issue.code), ...reasonCodes, ...warnings])];
  const employmentId = row.employee?.employmentId ?? null;
  return {
    rowNumber: row.rowNumber,
    employeeEmail: row.employeeEmail,
    employeeEmploymentId: employmentId,
    requestedPrimaryManagerEmail: row.primaryManagerEmail,
    // Only a manager the row names. A blank primary means "unchanged", resolved at commit time.
    requestedPrimaryManagerEmploymentId: row.primaryManager?.employmentId ?? null,
    currentPrimaryManagerEmploymentId: employmentId === null ? null : currentOf.get(employmentId)?.managerEmploymentId ?? null,
    secondaryManagerEmail1: row.secondaryEmails[0] ?? null,
    secondaryManagerEmail2: row.secondaryEmails[1] ?? null,
    secondaryManagerEmail3: row.secondaryEmails[2] ?? null,
    effectiveFrom: row.effectiveFrom,
    rowReason: row.reason,
    changesLast24h: validation?.primaryChangesLast24h ?? 0,
    status,
    codes: codes.length > 0 ? codes.join(",") : null,
    message: issues[0]?.message ?? (reasonCodes.length > 0 ? "Give this employee an individual reason before committing." : null),
  };
}

/**
 * Rows whose new primary managers point at each other inside this one file (A→B and B→A): each is
 * valid against the stored hierarchy on its own, so only the file's own graph shows the loop.
 */
export function rejectFileCycles(rows: PlannedRow[]): void {
  // The graph helper keys people by any unique string; user ids are unique where emails may be null.
  const edges = rows.flatMap((row) =>
    row.employee && row.primaryManager && row.issues.length === 0
      ? [{ row: row.rowNumber, email: row.employee.userId, managerEmail: row.primaryManager.userId }]
      : [],
  );
  const cyclic = new Set(findManagerCycles(edges).map((finding) => finding.row));
  for (const row of rows)
    if (cyclic.has(row.rowNumber))
      row.issues.push({ code: CODES.PRIMARY_CYCLE, message: "This file makes these employees each other's managers, which is a circular management chain." });
}

/**
 * Both request shapes become one row list, with every person resolved in two statements and the
 * employees narrowed to the caller's scope in a third: an employee outside it reads exactly like
 * one the organization does not have.
 */
export async function planBulkRows(db: DbOrTx, read: ScopedRead, body: CreateBulkJobInput, defaultDate: string): Promise<PlannedRow[]> {
  const orgId = read.orgId;
  if ("employeeUserIds" in body) {
    const people = await peopleByUserIds(db, orgId, [...body.employeeUserIds, body.primaryManagerUserId]);
    const visible = await visibleUserIds(read, db, body.employeeUserIds);
    const manager = people.get(body.primaryManagerUserId);
    const seen = new Set<string>();
    return body.employeeUserIds.map((userId, index) => {
      const employee = visible.has(userId) ? people.get(userId) : undefined;
      const row: PlannedRow = {
        rowNumber: index + 1,
        employeeEmail: employee?.email ?? userId,
        employee,
        primaryManagerEmail: manager?.email ?? null,
        primaryManager: manager,
        secondaryEmails: [],
        secondary: [],
        effectiveFrom: defaultDate,
        reason: null,
        issues: [],
      };
      checkPeople(row, seen, true);
      return row;
    });
  }
  const emails = body.rows.flatMap((row) => [
    row.employeeEmail,
    ...[row.primaryManagerEmail, row.secondaryManagerEmail1, row.secondaryManagerEmail2, row.secondaryManagerEmail3].flatMap((email) => (email ? [email] : [])),
  ]);
  const people = await peopleByEmails(db, orgId, emails);
  const visible = await visibleUserIds(
    read,
    db,
    body.rows.flatMap((row) => {
      const person = people.get(row.employeeEmail);
      return person ? [person.userId] : [];
    }),
  );
  const seen = new Set<string>();
  return body.rows.map((input, index) => {
    const found = people.get(input.employeeEmail);
    const secondaryEmails = [input.secondaryManagerEmail1, input.secondaryManagerEmail2, input.secondaryManagerEmail3].flatMap((email) => (email ? [email] : []));
    const row: PlannedRow = {
      rowNumber: index + 1,
      employeeEmail: input.employeeEmail,
      employee: found && visible.has(found.userId) ? found : undefined,
      primaryManagerEmail: input.primaryManagerEmail ?? null,
      primaryManager: input.primaryManagerEmail ? people.get(input.primaryManagerEmail) : undefined,
      secondaryEmails,
      secondary: secondaryEmails.map((email) => people.get(email)),
      effectiveFrom: input.effectiveFrom ?? defaultDate,
      reason: meaningful(input.reason),
      issues: [],
    };
    checkPeople(row, seen, input.primaryManagerEmail !== undefined);
    return row;
  });
}

function checkPeople(row: PlannedRow, seen: Set<string>, primaryNamed: boolean): void {
  if (!row.employee?.employmentId)
    row.issues.push({ code: CODES.EMPLOYEE_NOT_FOUND, message: `${row.employeeEmail} is not an employee of this organization.` });
  else if (seen.has(row.employee.userId))
    row.issues.push({ code: CODES.SECONDARY_DUPLICATE, message: "This employee appears more than once in the file." });
  if (row.employee) seen.add(row.employee.userId);
  if (primaryNamed && !row.primaryManager)
    row.issues.push({ code: CODES.MANAGER_NOT_FOUND, message: `${row.primaryManagerEmail ?? "The manager"} is not a member of this organization.` });
  row.secondary.forEach((person, index) => {
    if (!person)
      row.issues.push({ code: CODES.MANAGER_NOT_FOUND, message: `${row.secondaryEmails[index] ?? "A secondary manager"} is not a member of this organization.` });
  });
}
