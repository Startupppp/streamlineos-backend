import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OrgUnitKind } from "../../db/schema/common/organization";
import type { InviteActor } from "../organization/core/invitations.service";
import { EmailService } from "../email/email.service";
import { AccessService } from "../access/access.service";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import { addHours } from "date-fns";
import { hashToken } from "../../common/security/token.util";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { InvitationsService } from "../organization/core/invitations.service";
import {
  invitations,
  magicLinkTokens,
  organizationMembers,
  users,
  orgUnitMembers,
  orgUnits,
  hrPeople,
  hrEmployments,
} from "../../db/schema";
import type { BulkUpdateUsersInput, ImportUsersRow } from "./dto/users.schemas";
import { UsersService } from "./users.service";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";
import { assertMayGrantRole } from "../../common/rbac/assert-may-grant-role";
import { assertNoOwnerAmongTargets } from "../../common/rbac/assert-target-not-owner";
import { membershipStatusToUserStatus } from "../organization/core/org-membership.service";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";

@Injectable()
export class UserOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly invitationsSvc: InvitationsService,
    private readonly usersSvc: UsersService,
    private readonly access: AccessService,
    private readonly email: EmailService,
  ) {}

  async exportUsers(orgId: string): Promise<string> {
    const data = await this.db
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

    const rows = data.map((u) =>
      [
        csvCell(u.id),
        csvCell(u.email),
        csvCell(u.firstName),
        csvCell(u.lastName),
        csvCell(u.role),
        csvCell(membershipStatusToUserStatus(u.membershipStatus)),
        csvCell(u.emailVerified),
        csvCell(u.departmentId),
        csvCell(u.designation),
        csvCell(u.phone),
        csvCell(u.joinedAt),
        csvCell(u.createdAt),
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
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(eq(organizationMembers.orgId, orgId)),
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.status, ["ACTIVE", "INVITED"]),
              ),
            ),
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "SUSPENDED"),
              ),
            ),
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "LEFT"),
              ),
            ),
          this.db
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
          this.db
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

  private async bulkUpdateStatus(
    orgId: string,
    userIds: string[],
    status: "active" | "suspended" | "archived",
    actorUserId: string,
    fallbackError: string,
  ) {
    const results: Array<{ userId: string; success: boolean; error?: string }> =
      [];
    for (const userId of userIds) {
      try {
        await this.usersSvc.updateUserStatus(
          orgId,
          userId,
          status,
          actorUserId,
        );
        results.push({ userId, success: true });
      } catch (err) {
        results.push({
          userId,
          success: false,
          error: err instanceof HttpException ? err.message : fallbackError,
        });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
  }

  async bulkSuspend(orgId: string, userIds: string[], actorUserId: string) {
    return this.bulkUpdateStatus(
      orgId,
      userIds,
      "suspended",
      actorUserId,
      "Failed to suspend",
    );
  }

  async bulkArchive(orgId: string, userIds: string[], actorUserId: string) {
    return this.bulkUpdateStatus(
      orgId,
      userIds,
      "archived",
      actorUserId,
      "Failed to archive",
    );
  }

  async bulkRestore(orgId: string, userIds: string[], actorUserId: string) {
    return this.bulkUpdateStatus(
      orgId,
      userIds,
      "active",
      actorUserId,
      "Failed to restore",
    );
  }

  private assertMayGrantRole(
    orgId: string,
    actor: InviteActor,
    role: string,
  ): Promise<void> {
    return assertMayGrantRole(this.access, orgId, actor, role);
  }

  async bulkUpdateUsers(
    orgId: string,
    data: BulkUpdateUsersInput,
    actor: InviteActor,
  ) {
    const actorUserId = actor.userId;
    const { userIds, role, departmentId, branchId, teamId, managerUserId } =
      data;

    if (role) await this.assertMayGrantRole(orgId, actor, role);

    const scopedIds = await this.db.transaction(async (tx) => {
      if (managerUserId) {
        const manager = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, managerUserId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
          columns: { userId: true },
        });
        if (!manager)
          throw new BadRequestException(
            "Manager must be an active member of this organization",
          );
      }

      const memberRows = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.userId, userIds),
        ),
      );
      const tenantUserIds = memberRows.map((r) => r.userId);

      if (tenantUserIds.length === 0) return [];

      const userUpdate: Record<string, unknown> = {};
      if (departmentId !== undefined) userUpdate.orgDepartmentId = departmentId;
      if (branchId !== undefined) userUpdate.branchId = branchId;
      if (managerUserId !== undefined) userUpdate.reportingTo = managerUserId;

      if (Object.keys(userUpdate).length > 0) {
        await tx
        .update(users)
        .set(userUpdate)
        .where(inArray(users.id, tenantUserIds));

        if (departmentId !== undefined) {
          await tx
          .update(hrEmployments)
          .set({ departmentId })
          .where(
            and(
              eq(hrEmployments.orgId, orgId),
              eq(hrEmployments.isPrimary, true),
              isNull(hrEmployments.deletedAt),
              sql`EXISTS (
                SELECT 1 FROM ${hrPeople}
                WHERE ${hrPeople.id} = ${hrEmployments.personId}
                  AND ${hrPeople.orgId} = ${orgId}
                  AND ${inArray(hrPeople.userId, tenantUserIds)}
                  AND ${hrPeople.deletedAt} IS NULL
              )`,
            ),
          );
        }
      }

      const unitMoves: Array<{ kind: OrgUnitKind; unitId: string | null }> = [];
      if (branchId !== undefined)
        unitMoves.push({ kind: "BRANCH", unitId: branchId ?? null });
      if (departmentId !== undefined)
        unitMoves.push({ kind: "DEPARTMENT", unitId: departmentId ?? null });
      if (teamId !== undefined)
        unitMoves.push({ kind: "TEAM", unitId: teamId ?? null });

      if (unitMoves.length > 0) {
        for (const { kind, unitId } of unitMoves) {
          const existing = await tx
            .select({ id: orgUnitMembers.id })
            .from(orgUnitMembers)
            .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
            .where(
              and(
                eq(orgUnitMembers.orgId, orgId),
                inArray(orgUnitMembers.userId, tenantUserIds),
                eq(orgUnits.kind, kind),
              ),
            );
          if (existing.length > 0) {
            await tx
              .delete(orgUnitMembers)
              .where(inArray(orgUnitMembers.id, existing.map((row) => row.id)));
          }

          if (unitId !== null) {
            await tx
                .insert(orgUnitMembers)
                .values(tenantUserIds.map((userId) => ({
                  id: randomUUID(),
                  orgId,
                  orgUnitId: unitId,
                  userId,
                  role: "member",
                })))
                .onConflictDoNothing();
          }
        }
      }

      if (role) {
        await assertNoOwnerAmongTargets(tx, orgId, tenantUserIds);
        const rows = await tx
          .update(organizationMembers)
          .set({ role })
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              inArray(organizationMembers.userId, tenantUserIds),
            ),
          )
          .returning({ id: organizationMembers.id });
        for (const row of rows) {
          await syncStructuralRoleAssignment(tx, orgId, row.id, role);
        }
      }

      return tenantUserIds;
    });

    if (scopedIds.length === 0) return { success: true, updated: 0 };

    if (role) {
      await Promise.all(
        scopedIds.map((id) => bustMembershipStatusCache(this.cache, id, orgId)),
      );
    }

    this.audit.log({
      action: "user.bulk_updated",
      userId: actorUserId,
      orgId,
      targetType: "user",
      metadata: {
        userIds: scopedIds,
        changes: { role, departmentId, branchId, teamId, managerUserId },
      },
    });

    return { success: true, updated: scopedIds.length };
  }

  async sendSigninLink(orgId: string, userId: string, actorUserId: string) {
    const member = await this.usersSvc.getUser(orgId, userId);
    if (member.userStatus !== "active") {
      throw new BadRequestException(
        "Sign-in links can only be sent to active members",
      );
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });
    if (!user) throw new NotFoundException("User not found");

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt: addHours(new Date(), 24),
    });

    await this.email.sendMagicLinkEmail(user.email, rawToken);

    this.audit.log({
      action: "user.signin_link_sent",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      metadata: { email: user.email },
    });

    return { success: true, email: user.email };
  }

  async importUsers(orgId: string, rows: ImportUsersRow[], actor: InviteActor) {
    const actorUserId = actor.userId;
    const results: Array<{
      email: string;
      success: boolean;
      error?: string;
      invitationId?: string;
    }> = [];

    for (const row of rows) {
      try {
        const result = await this.invitationsSvc.invite(
          orgId,
          actor,
          row.email,
          row.role ?? "MEMBER",
        );
        results.push({
          email: row.email,
          success: true,
          invitationId: result.invitationId,
        });
      } catch (err) {
        results.push({
          email: row.email,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    this.audit.log({
      action: "user.bulk_imported",
      userId: actorUserId,
      orgId,
      metadata: { total: rows.length, succeeded, failed },
    });

    return { results, succeeded, failed, total: rows.length };
  }
}
