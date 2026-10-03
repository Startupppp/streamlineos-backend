import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  hrEmployments,
  hrPeople,
  leaveTypes,
  organizationPeople,
  orgUnits,
  users,
} from "../../../db/schema";
import { acceptedEmployee } from "../shared/employee-acceptance";
import type { HrImportEntity } from "./dto/import-job.dto";
import type { RowValidationResult } from "./schemas/entity-row-schemas";

/**
 * The one reference-resolution pass an import makes, between schema validation
 * and `hr_import_rows` (V-010e, V-011c/e, V-012c).
 *
 * `validateRows` is deliberately database-blind, so every reference a file names
 * — a department, a manager, a leave type, an employee email — was only ever
 * checked at commit. The preview therefore told the operator "3 valid, 1 error"
 * about a file that was about to fail three rows, and the counts the UI showed
 * before and after the commit disagreed with each other. Worse, the employees
 * import never looked at `departmentName` or `managerEmail` at all, so those
 * columns were parsed and thrown away in silence.
 *
 * Everything here is batched: one query per distinct reference per file, never
 * per row. The resolved ids are written onto the stored payload, which is also
 * what removes the per-row lookup the commit service used to do.
 *
 * A reference that does not resolve becomes a ROW ERROR with the same wording
 * the commit used to throw, so preview and commit finally agree.
 */

/**
 * Payload keys this pass owns. A CSV could name a column `resolvedUserId` and
 * hand the commit a user id from another tenant, so the keys are stripped off
 * every raw row before it is validated (`stripResolvedKeys`) and only ever
 * written back here, from an org-scoped query.
 */
const RESOLVED_KEYS = [
  "resolvedUserId",
  "resolvedLeaveTypeId",
  "resolvedDepartmentId",
  "resolvedManagerEmploymentId",
  "resolvedPrimaryManagerUserId",
  "primaryManagerResolution",
  "resolvedExistingEmployee",
] as const;

export function stripResolvedKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!RESOLVED_KEYS.some((key) => key in raw)) return raw;
  const copy = { ...raw };
  for (const key of RESOLVED_KEYS) delete copy[key];
  return copy;
}

type Row = RowValidationResult;

function cell(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function emailCell(payload: Record<string, unknown>, key: string): string {
  return cell(payload, key).toLowerCase();
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

const lowerWorkEmail = sql<string>`lower(trim(${organizationPeople.workEmail}))`;

const personOfOrgPerson = and(
  eq(organizationPeople.organizationId, hrPeople.orgId),
  eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
);

interface MemberRef {
  userId: string;
  /** `users.is_active AND users.email_verified IS NOT NULL` — the one definition. */
  accepted: boolean;
}

/** Distinct work emails -> the org's member behind each, in one query. */
async function membersByEmail(
  db: Db,
  orgId: string,
  emails: string[],
): Promise<Map<string, MemberRef>> {
  const found = new Map<string, MemberRef>();
  if (emails.length === 0) return found;

  const rows = await db
    .select({
      email: lowerWorkEmail,
      userId: hrPeople.userId,
      accepted: sql<boolean>`(${acceptedEmployee()})`,
    })
    .from(hrPeople)
    .innerJoin(organizationPeople, personOfOrgPerson)
    .innerJoin(users, eq(users.id, hrPeople.userId))
    .where(
      and(
        eq(hrPeople.orgId, orgId),
        isNull(hrPeople.deletedAt),
        inArray(lowerWorkEmail, emails),
      ),
    );

  for (const row of rows) {
    if (!row.userId || found.has(row.email)) continue;
    found.set(row.email, { userId: row.userId, accepted: row.accepted === true });
  }
  return found;
}

export interface PreflightResult {
  valid: Row[];
  errors: Row[];
}

/**
 * Resolves every reference the file names and splits the schema-valid rows into
 * the ones a commit can actually write and the ones that are row errors.
 */
export async function resolveRowReferences(
  db: Db,
  orgId: string,
  entity: HrImportEntity,
  rows: Row[],
): Promise<PreflightResult> {
  if (rows.length === 0) return { valid: [], errors: [] };

  const failures = new Map<number, string>();
  const fail = (row: Row, message: string) => {
    if (!failures.has(row.rowNumber)) failures.set(row.rowNumber, message);
  };

  if (entity === "employees") await resolveEmployees(db, orgId, rows, fail);
  else if (entity === "leave_balances") await resolveLeaveBalances(db, orgId, rows, fail);
  else if (entity === "attendance") await resolveAttendance(db, orgId, rows, fail);
  else if (entity === "assets") await resolveAssets(db, orgId, rows, fail);

  const valid: Row[] = [];
  const errors: Row[] = [];
  for (const row of rows) {
    const message = failures.get(row.rowNumber);
    if (message === undefined) valid.push(row);
    else errors.push({ ...row, status: "error", error: message });
  }
  return { valid, errors };
}

type Fail = (row: Row, message: string) => void;

const MANAGER_COLUMNS = ["primaryManagerEmail", "secondaryManagerEmail1", "secondaryManagerEmail2", "secondaryManagerEmail3"] as const;

async function resolveEmployees(db: Db, orgId: string, rows: Row[], fail: Fail) {
  const departmentNames = distinct(
    rows.map((row) => cell(row.payload, "departmentName").toLowerCase()),
  );
  const departmentIds = distinct(rows.map((row) => cell(row.payload, "departmentId")));
  const managerEmails = distinct(rows.flatMap((row) => MANAGER_COLUMNS.map((key) => emailCell(row.payload, key))));
  const employeeNumbers = distinct(rows.map((row) => cell(row.payload, "employeeNumber")));
  const emails = distinct(rows.map((row) => emailCell(row.payload, "email")));
  const roster = new Set(emails);

  const lowerUnitName = sql<string>`lower(trim(${orgUnits.name}))`;
  const [byName, byId, managers, members, numberOwners] = await Promise.all([
    departmentNames.length === 0
      ? []
      : db
          .select({ key: lowerUnitName, id: orgUnits.id })
          .from(orgUnits)
          .where(
            and(
              eq(orgUnits.orgId, orgId),
              isNull(orgUnits.deletedAt),
              inArray(lowerUnitName, departmentNames),
            ),
          ),
    departmentIds.length === 0
      ? []
      : db
          .select({ key: orgUnits.id, id: orgUnits.id })
          .from(orgUnits)
          .where(
            and(
              eq(orgUnits.orgId, orgId),
              isNull(orgUnits.deletedAt),
              inArray(orgUnits.id, departmentIds),
            ),
          )
          .limit(departmentIds.length),
    membersByEmail(db, orgId, managerEmails),
    membersByEmail(db, orgId, emails),
    employeeNumbers.length === 0
      ? []
      : db
          .select({ employeeNumber: hrEmployments.employeeNumber, userId: hrPeople.userId })
          .from(hrEmployments)
          .innerJoin(
            hrPeople,
            and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)),
          )
          .where(
            and(
              eq(hrEmployments.orgId, orgId),
              inArray(hrEmployments.employeeNumber, employeeNumbers),
            ),
          ),
  ]);

  const unitByName = new Map(byName.map((unit) => [unit.key, unit.id]));
  const unitById = new Map(byId.map((unit) => [unit.key, unit.id]));
  const ownerOfNumber = new Map(
    numberOwners.map((owner) => [owner.employeeNumber, owner.userId]),
  );

  for (const row of rows) {
    const statedId = cell(row.payload, "departmentId");
    const statedName = cell(row.payload, "departmentName");
    if (statedId !== "") {
      const resolved = unitById.get(statedId);
      if (resolved === undefined)
        fail(row, `Department "${statedId}" was not found in this organization.`);
      else row.payload.resolvedDepartmentId = resolved;
    } else if (statedName !== "") {
      const resolved = unitByName.get(statedName.toLowerCase());
      if (resolved === undefined)
        fail(row, `Department "${statedName}" was not found in this organization.`);
      else row.payload.resolvedDepartmentId = resolved;
    }

    // HRM-15: a manager is an existing member (resolved to a user id here) or another row of this
    // file (resolved at commit, which writes managers first). Anything else is a row error.
    for (const key of MANAGER_COLUMNS) {
      const managerEmail = emailCell(row.payload, key);
      if (managerEmail === "") continue;
      const manager = managers.get(managerEmail);
      if (key === "primaryManagerEmail" && manager) row.payload.resolvedPrimaryManagerUserId = manager.userId;
      if (!manager && !roster.has(managerEmail))
        fail(row, `Manager "${managerEmail}" is neither an employee of this organization nor a row of this file.`);
    }
    if (members.has(emailCell(row.payload, "email"))) row.payload.resolvedExistingEmployee = true;

    // The commit used to be the first place a taken employee number was noticed,
    // so the preview promised a row it could not write.
    const employeeNumber = cell(row.payload, "employeeNumber");
    if (employeeNumber !== "") {
      const owner = ownerOfNumber.get(employeeNumber);
      const self = members.get(emailCell(row.payload, "email"))?.userId;
      if (owner && owner !== self)
        fail(
          row,
          `Employee number "${employeeNumber}" already belongs to someone else in this organization.`,
        );
    }
  }
}

async function resolveLeaveBalances(db: Db, orgId: string, rows: Row[], fail: Fail) {
  const emails = distinct(rows.map((row) => emailCell(row.payload, "employeeEmail")));
  const typeNames = distinct(rows.map((row) => cell(row.payload, "leaveTypeName")));

  const [members, types] = await Promise.all([
    membersByEmail(db, orgId, emails),
    typeNames.length === 0
      ? []
      : db
          .select({ id: leaveTypes.id, name: leaveTypes.name })
          .from(leaveTypes)
          .where(and(eq(leaveTypes.orgId, orgId), inArray(leaveTypes.name, typeNames)))
          .limit(typeNames.length),
  ]);
  const typeByName = new Map(types.map((type) => [type.name, type.id]));

  for (const row of rows) {
    const email = emailCell(row.payload, "employeeEmail");
    const member = members.get(email);
    if (!member) {
      fail(row, `No user found for email ${cell(row.payload, "employeeEmail")}`);
    } else {
      row.payload.resolvedUserId = member.userId;
    }

    const typeName = cell(row.payload, "leaveTypeName");
    const typeId = typeByName.get(typeName);
    if (typeId === undefined) fail(row, `Leave type '${typeName}' not found`);
    else row.payload.resolvedLeaveTypeId = typeId;
  }
}

async function resolveAttendance(db: Db, orgId: string, rows: Row[], fail: Fail) {
  const emails = distinct(rows.map((row) => emailCell(row.payload, "employeeEmail")));
  const members = await membersByEmail(db, orgId, emails);

  for (const row of rows) {
    const stated = cell(row.payload, "employeeEmail");
    const member = members.get(stated.toLowerCase());
    if (!member) {
      fail(row, `No user found for email ${stated}`);
      continue;
    }
    // V-012. The lookup used to stop at "exists in this org", so attendance
    // could be written for somebody who has never opened their invitation.
    if (!member.accepted) {
      fail(
        row,
        `${stated} has not accepted their invitation yet, so attendance cannot be imported for them`,
      );
      continue;
    }
    row.payload.resolvedUserId = member.userId;
  }
}

async function resolveAssets(db: Db, orgId: string, rows: Row[], fail: Fail) {
  const emails = distinct(rows.map((row) => emailCell(row.payload, "assignedToEmail")));
  if (emails.length === 0) return;
  const members = await membersByEmail(db, orgId, emails);

  for (const row of rows) {
    const stated = cell(row.payload, "assignedToEmail");
    if (stated === "") continue;
    const member = members.get(stated.toLowerCase());
    // V-080. A typo used to leave the asset unassigned and the row reported as
    // imported, which is a silent drop of the only column an operator checks.
    if (!member) fail(row, `No user found for email ${stated}`);
    else row.payload.resolvedUserId = member.userId;
  }
}
