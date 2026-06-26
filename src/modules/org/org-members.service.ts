import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, type SQL } from "drizzle-orm";
import { organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { pushBranchAssigneeFilter, type BranchContext } from "../leads/branch-filter";

@Injectable()
export class OrgMembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMembers(orgId: string, ctx: BranchContext) {
    const conditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      eq(users.isActive, true),
    ];

    await pushBranchAssigneeFilter(this.db, conditions, users.id, ctx);

    return this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        name: users.name,
        email: users.email,
        image: users.image,
        role: users.role,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(...conditions))
      .orderBy(asc(users.firstName));
  }
}
