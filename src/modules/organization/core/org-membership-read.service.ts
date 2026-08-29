import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, ilike, inArray, or } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

@Injectable()
export class OrgMembershipReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    page: number,
    limit: number,
    search: string | undefined,
    userIds: string[] | undefined,
    includeInactive: boolean,
  ) {
    const offset = (page - 1) * limit;
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
    if (!includeInactive) baseConditions.push(eq(organizationMembers.status, "ACTIVE"));
    if (userIds && userIds.length > 0) baseConditions.push(inArray(organizationMembers.userId, userIds));
    const conditions = search
      ? [...baseConditions, or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`))]
      : baseConditions;

    const [dataResult, countResult] = await Promise.all([
      this.db
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
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;
    return { data: dataResult, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}
