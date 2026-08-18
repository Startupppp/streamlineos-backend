import { and, count, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { invitations, organizationMembers, users } from "../../db/schema";
import { membershipStatusToUserStatus } from "../organization/core/org-membership.service";

export class UserOperationsReporter {
  constructor(
    private readonly database: Db,
    private readonly cache: CacheService,
  ) {}

  async exportUsers(orgId: string): Promise<string> {
    const data = await this.database
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: organizationMembers.role,
        membershipStatus: organizationMembers.status,
        emailVerified: users.emailVerified,
        departmentId: users.orgDepartmentId,
        designation: users.designation,
        phone: users.phone,
        joinedAt: organizationMembers.joinedAt,
        createdAt: users.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(desc(organizationMembers.joinedAt));

    const headers = [
      "id",
      "email",
      "firstName",
      "lastName",
      "role",
      "status",
      "emailVerified",
      "departmentId",
      "designation",
      "phone",
      "joinedAt",
      "createdAt",
    ] as const;

    const csvCell = (
      val: string | boolean | Date | null | undefined,
    ): string => {
      if (val === null || val === undefined) return "";
      if (val instanceof Date) return val.toISOString();
      return String(val).replace(/,/g, ";");
    };

    const rows = data.map((userRecord) =>
      [
        csvCell(userRecord.id),
        csvCell(userRecord.email),
        csvCell(userRecord.firstName),
        csvCell(userRecord.lastName),
        csvCell(userRecord.role),
        csvCell(membershipStatusToUserStatus(userRecord.membershipStatus)),
        csvCell(userRecord.emailVerified),
        csvCell(userRecord.departmentId),
        csvCell(userRecord.designation),
        csvCell(userRecord.phone),
        csvCell(userRecord.joinedAt),
        csvCell(userRecord.createdAt),
      ].join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  async getStats(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.usersStats(orgId),
      async () => {
        const [
          totalResult,
          activeResult,
          suspendedResult,
          archivedResult,
          pendingResult,
          newThisMonthResult,
        ] = await Promise.all([
          this.database
            .select({ count: count() })
            .from(organizationMembers)
            .where(eq(organizationMembers.orgId, orgId)),
          this.database
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.status, ["ACTIVE", "INVITED"]),
              ),
            ),
          this.database
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "SUSPENDED"),
              ),
            ),
          this.database
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "LEFT"),
              ),
            ),
          this.database
            .select({ count: count() })
            .from(invitations)
            .where(
              and(
                eq(invitations.orgId, orgId),
                eq(invitations.status, "PENDING"),
                isNull(invitations.acceptedAt),
                gt(invitations.expiresAt, new Date()),
              ),
            ),
          this.database
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                gte(
                  organizationMembers.joinedAt,
                  sql`DATE_TRUNC('month', NOW())`,
                ),
              ),
            ),
        ]);

        return {
          total: totalResult[0]?.count ?? 0,
          active: activeResult[0]?.count ?? 0,
          suspended: suspendedResult[0]?.count ?? 0,
          archived: archivedResult[0]?.count ?? 0,
          pendingInvitations: pendingResult[0]?.count ?? 0,
          newThisMonth: newThisMonthResult[0]?.count ?? 0,
        };
      },
      60,
    );
  }
}
