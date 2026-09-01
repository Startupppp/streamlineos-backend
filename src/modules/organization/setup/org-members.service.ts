import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, or, ilike, sql, type SQL } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
const MAX_MEMBER_RESULTS = 100;

export interface ListMembersOptions {
  search?: string;
  limit?: number;
}

@Injectable()
export class OrgMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMembers(orgId: string, options: ListMembersOptions = {}) {
    const conditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
    ];

    const term = options.search?.trim();
    if (term) {
      const pattern = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const match = or(
        ilike(users.name, pattern),
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
        ilike(users.email, pattern),
        ilike(sql`${users.firstName} || ' ' || ${users.lastName}`, pattern),
      );
      if (match) conditions.push(match);
    }

    const limit = Math.min(options.limit ?? MAX_MEMBER_RESULTS, MAX_MEMBER_RESULTS);
    return this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        name: users.name,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(users.firstName))
      .limit(limit);
  }
}
