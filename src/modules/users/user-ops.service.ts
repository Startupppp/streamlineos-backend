import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OrgUnitKind } from "../../db/schema/common/organization";
import type { InviteActor } from "../organization/core/invitations.helpers";
import { EmailService } from "../email/email.service";
import { AccessService } from "../access/access.service";
import {
  and,
  eq,
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
import { InvitationCreateService } from "../organization/core/invitation-create.service";
import {
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
import { syncStructuralRoleAssignments } from "../../common/rbac/sync-structural-role";
import {
  assertMayGrantRole,
  assertMayManageOrganizationMembership,
} from "../../common/rbac/assert-may-grant-role";
import { assertNoOwnerAmongTargets } from "../../common/rbac/assert-target-not-owner";
import { scheduleMembershipBustMany } from "../../common/org/membership-bust";
import { UserOperationsReporter } from "./user-operations.reporter";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { syncCanonicalReportingLines } from "../../common/hr/sync-canonical-reporting-line";

@Injectable()
export class UserOpsService {
  private readonly reporter: UserOperationsReporter;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly invitationsSvc: InvitationCreateService,
    private readonly usersSvc: UsersService,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly employment: EmploymentFactsService,
  ) {
    this.reporter = new UserOperationsReporter(db, cache, employment);
  }

  exportUsers(orgId: string) {
    return this.reporter.exportUsers(orgId);
  }

  async getStats(orgId: string) {
    return this.reporter.getStats(orgId);
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
      succeeded: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
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
      const tenantUserIds = memberRows.map(
        (membership) => membership.userId,
      );

      if (tenantUserIds.length === 0) return [];

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

      if (branchId !== undefined) {
        await tx
        .update(hrEmployments)
        .set({ locationId: branchId })
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

      if (managerUserId !== undefined) {
        const today = new Date().toISOString().slice(0, 10);
        await syncCanonicalReportingLines(
          tx,
          orgId,
          tenantUserIds,
          managerUserId,
          today,
          actorUserId,
        );
      }

      const unitMoves: Array<{ kind: OrgUnitKind; unitId: string | null }> = [];
      if (branchId !== undefined)
        unitMoves.push({ kind: "BRANCH", unitId: branchId ?? null });
      if (departmentId !== undefined)
        unitMoves.push({ kind: "DEPARTMENT", unitId: departmentId ?? null });
      if (teamId !== undefined)
        unitMoves.push({ kind: "TEAM", unitId: teamId ?? null });

      if (unitMoves.length > 0) {
        const memberRows = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              inArray(organizationMembers.userId, tenantUserIds),
            ),
          );
        const membershipIds = memberRows.map((membership) => membership.id);

        if (membershipIds.length > 0) {
          const movedKinds = unitMoves.map((move) => move.kind);
          const existing = await tx
            .select({ id: orgUnitMembers.id })
            .from(orgUnitMembers)
            .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
            .where(
              and(
                eq(orgUnitMembers.orgId, orgId),
                inArray(orgUnitMembers.membershipId, membershipIds),
                inArray(orgUnits.kind, movedKinds),
              ),
            );
          if (existing.length > 0) {
            await tx
              .delete(orgUnitMembers)
              .where(inArray(orgUnitMembers.id, existing.map((row) => row.id)));
          }

          const additions = unitMoves.flatMap(({ unitId }) =>
            unitId === null
              ? []
              : membershipIds.map((membershipId) => ({
                  id: randomUUID(),
                  orgId,
                  orgUnitId: unitId,
                  membershipId,
                  role: "member",
                })),
          );
          if (additions.length > 0) {
            await tx.insert(orgUnitMembers).values(additions).onConflictDoNothing();
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
        await syncStructuralRoleAssignments(
          tx,
          orgId,
          rows.map((row) => row.id),
          role,
        );
      }

      return tenantUserIds;
    });

    if (scopedIds.length === 0) return { success: true, updated: 0 };

    if (role) await scheduleMembershipBustMany(this.cache, scopedIds);

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
    await assertMayManageOrganizationMembership(this.access, orgId, actor);

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

    const succeeded = results.filter((result) => result.success).length;
    const failed = results.filter((result) => !result.success).length;

    this.audit.log({
      action: "user.bulk_imported",
      userId: actorUserId,
      orgId,
      metadata: { total: rows.length, succeeded, failed },
    });

    return { results, succeeded, failed, total: rows.length };
  }
}

