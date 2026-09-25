import { and, asc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { hrEmployments, hrPeople, organizationMembers, users } from "../../../db/schema";
import { CANNOT_MANAGE_LIFECYCLE, managerStateOf } from "../../directory/reporting-line-queries";
import type { ManagerRef } from "../../directory/reporting-line.types";

/**
 * HRM-15 display reads for the people a reporting-manager screen names: a manager, a requester, a
 * bulk-row employee. One statement per id set, always tenant-bound, never the `users` row itself
 * (BE-46): only the projected name, email and state leave this file.
 */

const displayName = sql<string>`coalesce(
  nullif(trim(${users.name}), ''),
  nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

const personFields = {
  userId: users.id,
  name: displayName,
  email: users.email,
  designation: hrEmployments.designation,
  employmentId: hrEmployments.id,
  lifecycleStatus: hrEmployments.lifecycleStatus,
  userActive: users.isActive,
  membershipStatus: organizationMembers.status,
};

type PersonRow = {
  userId: string;
  name: string;
  email: string;
  designation: string | null;
  employmentId: number | null;
  lifecycleStatus: string | null;
  userActive: boolean;
  membershipStatus: string;
};

export interface PersonRef extends ManagerRef {
  employmentId: number | null;
}

function refOf(row: PersonRow): PersonRef {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    designation: row.designation,
    state: managerStateOf(row.userActive, row.membershipStatus, row.lifecycleStatus),
    employmentId: row.employmentId,
  };
}

function membersWithEmployment(db: DbOrTx, orgId: string, where: SQL | undefined, limit: number) {
  return db
    .select(personFields)
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.userId, users.id), isNull(hrPeople.deletedAt)))
    .leftJoin(
      hrEmployments,
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.personId, hrPeople.id),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
      ),
    )
    .where(and(eq(organizationMembers.orgId, orgId), where))
    .limit(limit);
}

/** Members of the org by user id; an id outside the tenant is simply absent. */
export async function peopleByUserIds(db: DbOrTx, orgId: string, userIds: readonly string[]): Promise<Map<string, PersonRef>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await membersWithEmployment(db, orgId, inArray(organizationMembers.userId, ids), ids.length * 2);
  return new Map(rows.map((row) => [row.userId, refOf(row)]));
}

/** Members of the org by canonical (trimmed, lower-case) email. */
export async function peopleByEmails(db: DbOrTx, orgId: string, emails: readonly string[]): Promise<Map<string, PersonRef>> {
  const wanted = [...new Set(emails)];
  if (wanted.length === 0) return new Map();
  const rows = await membersWithEmployment(db, orgId, inArray(sql`lower(trim(${users.email}))`, wanted), wanted.length * 2);
  return new Map(rows.map((row) => [row.email.trim().toLowerCase(), refOf(row)]));
}

/** Employees of the org by employment id, including one whose person has no user yet. */
export async function peopleByEmploymentIds(
  db: DbOrTx,
  orgId: string,
  employmentIds: readonly number[],
): Promise<Map<number, PersonRef>> {
  const ids = [...new Set(employmentIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      employmentId: hrEmployments.id,
      userId: hrPeople.userId,
      name: sql<string | null>`${displayName}`,
      email: users.email,
      designation: hrEmployments.designation,
      lifecycleStatus: hrEmployments.lifecycleStatus,
      userActive: users.isActive,
      membershipStatus: organizationMembers.status,
    })
    .from(hrEmployments)
    .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)))
    .leftJoin(users, eq(users.id, hrPeople.userId))
    .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, hrPeople.userId)))
    .where(and(eq(hrEmployments.orgId, orgId), inArray(hrEmployments.id, ids)))
    .limit(ids.length);
  return new Map(
    rows.map((row) => [
      row.employmentId,
      {
        userId: row.userId ?? "",
        name: row.name ?? "Unnamed employee",
        email: row.email,
        designation: row.designation,
        state: managerStateOf(row.userActive, row.membershipStatus, row.lifecycleStatus),
        employmentId: row.employmentId,
      },
    ]),
  );
}

export const MANAGER_CANDIDATE_LIMIT = 20;

function prefixPattern(term: string): string {
  return `${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
}

/**
 * People who could be picked as a reporting manager right now: an active, accepted member of this
 * org with a live primary employment that has not exited. The same bar `checkManager` applies, as a
 * query, so a picker never offers someone the write then refuses. Prefix search only (BE-49).
 */
export async function searchManagerCandidates(
  db: DbOrTx,
  orgId: string,
  input: { q?: string; excludeUserIds: readonly string[]; limit: number },
): Promise<ManagerRef[]> {
  const term = input.q?.trim().toLowerCase() ?? "";
  const pattern = prefixPattern(term);
  const exclude = input.excludeUserIds.filter((id) => id !== "");
  const rows = await db
    .select(personFields)
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.userId, users.id), isNull(hrPeople.deletedAt)))
    .innerJoin(
      hrEmployments,
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.personId, hrPeople.id),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
      ),
    )
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        eq(users.isActive, true),
        isNotNull(users.emailVerified),
        notInArray(hrEmployments.lifecycleStatus, [...CANNOT_MANAGE_LIFECYCLE, "CANDIDATE"]),
        exclude.length > 0 ? notInArray(users.id, exclude) : undefined,
        term === ""
          ? undefined
          : or(
              ilike(users.name, pattern),
              ilike(users.firstName, pattern),
              ilike(users.lastName, pattern),
              ilike(users.email, pattern),
            ),
      ),
    )
    .orderBy(asc(displayName), asc(users.id))
    .limit(Math.min(input.limit, MANAGER_CANDIDATE_LIMIT));
  return rows.map((row) => {
    const person = refOf(row);
    return { userId: person.userId, name: person.name, email: person.email, designation: person.designation, state: person.state };
  });
}
