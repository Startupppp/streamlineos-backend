import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

const memberSortName = sql<string>`coalesce(${users.name}, ${users.email})`;

type MemberCursorScope = {
  orgId: string;
  search: string | null;
  userIds: string[] | null;
  includeInactive: boolean;
};

function invalidMemberCursor(): never {
  throw new BadRequestException("Invalid pagination cursor");
}

function decodeMemberCursor(value: string | undefined, expected: MemberCursorScope) {
  if (!value) return null;

  const position = decodeCursor(value);
  if (!position) return invalidMemberCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    const id = Array.isArray(scope) ? Number(scope[4]) : Number.NaN;
    if (
      !Array.isArray(scope) ||
      scope.length !== 5 ||
      scope[0] !== expected.orgId ||
      scope[1] !== expected.search ||
      JSON.stringify(scope[2]) !== JSON.stringify(expected.userIds) ||
      scope[3] !== expected.includeInactive ||
      !Number.isSafeInteger(id) ||
      id < 1
    ) {
      return invalidMemberCursor();
    }
    return { sortValue: position.sortValue, id };
  } catch {
    return invalidMemberCursor();
  }
}

@Injectable()
export class OrgMembershipReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    cursorValue: string | undefined,
    limit: number,
    search: string | undefined,
    userIds: string[] | undefined,
    includeInactive: boolean,
  ) {
    const cappedLimit = Math.min(limit, 100);
    const normalizedUserIds = userIds?.length ? [...userIds].sort() : null;
    const cursorScope: MemberCursorScope = {
      orgId,
      search: search ?? null,
      userIds: normalizedUserIds,
      includeInactive,
    };
    const cursor = decodeMemberCursor(cursorValue, cursorScope);
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
    if (!includeInactive) baseConditions.push(eq(organizationMembers.status, "ACTIVE"));
    if (userIds && userIds.length > 0) baseConditions.push(inArray(organizationMembers.userId, userIds));
    const conditions = search
      ? [...baseConditions, or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`))]
      : baseConditions;
    if (cursor) {
      conditions.push(
        or(
          gt(memberSortName, cursor.sortValue),
          and(eq(memberSortName, cursor.sortValue), gt(organizationMembers.id, cursor.id)),
        ),
      );
    }

    const data = await this.db
      .select({
        membershipId: organizationMembers.id,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        name: users.name,
        email: users.email,
        image: users.image,
        totpEnabled: users.totpEnabled,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(memberSortName), asc(organizationMembers.id))
      .limit(cappedLimit + 1);

    return buildCursorPage(data, cappedLimit, (row) => ({
      sortValue: row.name ?? row.email,
      id: JSON.stringify([
        cursorScope.orgId,
        cursorScope.search,
        cursorScope.userIds,
        cursorScope.includeInactive,
        row.membershipId,
      ]),
    }));
  }
}
