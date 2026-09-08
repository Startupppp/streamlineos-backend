import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { hrEmployments, hrPeople, organizationMembers, users } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  liveEmployment,
  livePersonOfEmployment,
} from "../../../directory/employment-query";
import { ORG_MEMBER_ROLES } from "../../../../common/rbac/org-roles";
import { formatDateOnly } from "../../../../common/date";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import type { DepartmentCatalog } from "./bulk-onboarding-departments";
import type { BulkOnboardPlan, PlannedEmployee } from "./bulk-onboarding.types";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

export interface IdentitySnapshot {
  userIdByEmail: Map<string, string>;
  memberUserIds: Set<string>;
  employeeNumberOwner: Map<string, string | null>;
}

// Three org-scoped inArray queries taken before the loop instead of three per row.
export async function preloadIdentities(
  db: DbOrTx,
  orgId: string,
  emails: readonly string[],
  employeeNumbers: readonly string[],
): Promise<IdentitySnapshot> {
  const snapshot: IdentitySnapshot = {
    userIdByEmail: new Map(),
    memberUserIds: new Set(),
    employeeNumberOwner: new Map(),
  };
  if (emails.length === 0) return snapshot;

  const existingUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, [...emails]))
    .limit(emails.length);
  for (const user of existingUsers) snapshot.userIdByEmail.set(user.email.toLowerCase(), user.id);

  const userIds = [...snapshot.userIdByEmail.values()];
  if (userIds.length > 0) {
    const memberships = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.userId, userIds),
        ),
      )
      .limit(userIds.length);
    for (const membership of memberships) snapshot.memberUserIds.add(membership.userId);
  }

  if (employeeNumbers.length > 0) {
    const taken = await db
      .select({
        employeeNumber: hrEmployments.employeeNumber,
        userId: hrPeople.userId,
      })
      .from(hrEmployments)
      .innerJoin(hrPeople, livePersonOfEmployment(orgId))
      .where(
        and(
          liveEmployment(orgId),
          eq(hrEmployments.isPrimary, true),
          inArray(hrEmployments.employeeNumber, [...employeeNumbers]),
        ),
      )
      .limit(employeeNumbers.length);
    for (const row of taken) snapshot.employeeNumberOwner.set(row.employeeNumber, row.userId);
  }

  return snapshot;
}

export function canonicalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function distinctRoles(rows: readonly BulkOnboardEmployeeRow[]): string[] {
  return [...new Set(rows.map((row) => row.role || ORG_MEMBER_ROLES.MEMBER))];
}

function resolveDepartment(
  row: BulkOnboardEmployeeRow,
  catalog: DepartmentCatalog,
): { departmentId: string | null } | { error: string } {
  if (row.departmentId != null) {
    if (!catalog.activeIds.has(row.departmentId))
      return { error: "Unknown department. Create it under Organization → Departments (or HR departments) first." };
    return { departmentId: row.departmentId };
  }
  if (!row.department) return { departmentId: null };
  const resolved = catalog.byKey.get(row.department.trim().toLowerCase());
  if (!resolved)
    return {
      error: `Unknown department "${row.department}". Create it under Organization → Departments (or HR departments) first.`,
    };
  return { departmentId: resolved };
}

// Decides every row from the preloaded maps alone, so a rejected row costs no query and still reports why.
export function planBulkOnboarding(
  rows: readonly BulkOnboardEmployeeRow[],
  catalog: DepartmentCatalog,
  identities: IdentitySnapshot,
  roleErrors: Map<string, string>,
): BulkOnboardPlan {
  const plan: BulkOnboardPlan = { accepted: [], rejected: [] };
  const seenEmails = new Set<string>();
  const claimedNumbers = new Set(identities.employeeNumberOwner.keys());

  for (let index = 0; index < rows.length; index += 1) {
    const source = rows[index];
    const row = index + 1;
    const email = canonicalizeEmail(source.email);

    if (seenEmails.has(email)) {
      plan.rejected.push({ row, email, success: false, error: "Duplicate email in this upload" });
      continue;
    }
    seenEmails.add(email);

    const role = source.role || ORG_MEMBER_ROLES.MEMBER;
    const roleError = roleErrors.get(role);
    if (roleError) {
      plan.rejected.push({ row, email, success: false, error: roleError });
      continue;
    }

    const department = resolveDepartment(source, catalog);
    if ("error" in department) {
      plan.rejected.push({ row, email, success: false, error: department.error });
      continue;
    }

    const existingUserId = identities.userIdByEmail.get(email);
    if (existingUserId && identities.memberUserIds.has(existingUserId)) {
      plan.rejected.push({
        row,
        email,
        success: false,
        error: "This email already belongs to an employee in your organization.",
      });
      continue;
    }

    const requestedNumber = source.employeeId?.trim();
    if (requestedNumber) {
      const owner = identities.employeeNumberOwner.get(requestedNumber);
      if (owner !== undefined && owner !== existingUserId) {
        plan.rejected.push({
          row,
          email,
          success: false,
          error: `Employee ID "${requestedNumber}" is already in use in your organization.`,
        });
        continue;
      }
    }

    let employeeNumber = requestedNumber || `EMP-${randomEmployeeCode(6)}`;
    while (!requestedNumber && claimedNumbers.has(employeeNumber))
      employeeNumber = `EMP-${randomEmployeeCode(6)}`;
    claimedNumbers.add(employeeNumber);

    plan.accepted.push({
      row,
      email,
      source,
      userId: existingUserId ?? randomUUID(),
      isNewUser: existingUserId === undefined,
      role,
      departmentId: department.departmentId,
      employeeNumber,
      firstName: source.firstName.trim(),
      lastName: source.lastName.trim(),
      designation: source.designation.trim(),
      joiningDate: source.joiningDate ? formatDateOnly(source.joiningDate) : null,
      dateOfBirth: source.dateOfBirth ? formatDateOnly(source.dateOfBirth) : null,
    });
  }

  return plan;
}
