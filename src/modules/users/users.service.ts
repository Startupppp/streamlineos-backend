import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { InviteActor } from "../organization/core/invitations.service";
import { AccessService } from "../access/access.service";
import { and, count, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";
import { type Db } from "../../db/drizzle.module";
import {
  organizationMembers,
  users,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { InvitationsService } from "../organization/core/invitations.service";
import {
  OrgMembershipService,
  type MemberLifecycleStatus,
} from "../organization/core/org-membership.service";
import type {
  CreateUserInput,
  ListUsersInput,
  UpdateUserInput,
} from "./dto/users.schemas";
import { assertMayGrantRole } from "../../common/rbac/assert-may-grant-role";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import { assertTargetNotOwner } from "../../common/rbac/assert-target-not-owner";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import { withIdentity } from "../../common/tenant/with-identity";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { syncCanonicalEmploymentFields } from "../../common/hr/sync-canonical-employment-fields";
import { syncCanonicalReportingLine } from "../../common/hr/sync-canonical-reporting-line";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";
import { OrganizationUsersReader } from "./organization-users.reader";
import { EmploymentFactsService } from "../directory/employment-facts.service";

@Injectable()
export class UsersService {
  private readonly reader: OrganizationUsersReader;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly invitationsSvc: InvitationsService,
    private readonly orgMembership: OrgMembershipService,
    private readonly employment: EmploymentFactsService,
  ) {
    this.reader = new OrganizationUsersReader(db, employment);
  }

  private async invalidateMembershipCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      this.cache.invalidateForOrg(orgId, "users:stats"),
    ]);
  }

  async createUser(orgId: string, input: CreateUserInput, actor: InviteActor) {
    const actorUserId = actor.userId;
    const {
      email,
      firstName,
      lastName,
      role,
      designation,
      phone,
      departmentId,
      branchId,
      sendInvite,
    } = input;

    if (sendInvite) {
      return this.invitationsSvc.invite(orgId, actor, email, role);
    }

    await this.assertMayGrantRole(orgId, actor, role);

    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (existing) {
      const membership = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, existing.id),
        ),
        columns: { status: true },
      });
      if (membership) {
        if (membership.status === "SUSPENDED" || membership.status === "LEFT") {
          throw new ConflictException(
            "This person was archived/suspended in this organization. Restore them from Users instead of inviting again.",
          );
        }
        throw new ConflictException(
          "User is already a member of this organization",
        );
      }
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
          );
          await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
          const inserted = await tx
            .insert(organizationMembers)
            .values({ userId: existing.id, orgId, role })
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id });
          const membershipId = inserted[0]?.id;
          if (membershipId !== undefined)
            await syncStructuralRoleAssignment(tx, orgId, membershipId, role);

          await syncOrgUnitPlacement(tx, orgId, existing.id, {
            DEPARTMENT: departmentId ?? null,
            BRANCH: branchId ?? null,
          });

          await this.seatLedger.recordSeatEvent(
            {
              orgId,
              eventType: "INVITE_ACCEPTED",
              subjectId: existing.id,
              actorId: actorUserId,
              reason: "existing user added to organisation",
              idempotencyKey: `member-added:${orgId}:${existing.id}`,
            },
            tx,
          );
        },
        { orgId },
      );
      await bustMembershipStatusCache(this.cache, existing.id, orgId);
      await this.invalidateMembershipCaches(orgId);
      return { userId: existing.id, created: false };
    }

    const userId = randomUUID();
    const trimmedFirst = firstName?.trim() || null;
    const trimmedLast = lastName?.trim() || null;
    const fromNames =
      [trimmedFirst, trimmedLast].filter(Boolean).join(" ") || null;
    const emailLocal = email.split("@")[0]?.trim() || null;
    const fullName = fromNames ?? emailLocal;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
        );
        await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
        await tx.insert(users).values({
          id: userId,
          email,
          name: fullName,
          firstName: trimmedFirst,
          lastName: trimmedLast,
          emailVerified: new Date(),
          phone: phone ?? null,
          userStatus: "active",
          activatedAt: new Date(),
          isActive: true,
        });
        const inserted = await tx
          .insert(organizationMembers)
          .values({ userId, orgId, role })
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id });
        const membershipId = inserted[0]?.id;
        if (membershipId !== undefined) {
          await syncStructuralRoleAssignment(tx, orgId, membershipId, role);
        }
        await syncOrgUnitPlacement(tx, orgId, userId, {
          DEPARTMENT: departmentId ?? null,
          BRANCH: branchId ?? null,
        });

        await this.seatLedger.recordSeatEvent(
          {
            orgId,
            eventType: "INVITE_ACCEPTED",
            subjectId: userId,
            actorId: actorUserId,
            reason: "user created directly",
            idempotencyKey: `member-added:${orgId}:${userId}`,
          },
          tx,
        );
      },
      { orgId },
    );

    await bustMembershipStatusCache(this.cache, userId, orgId);
    await this.invalidateMembershipCaches(orgId);

    this.audit.log({
      action: "user.created",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
      metadata: { email, role },
    });

    return { userId, created: true };
  }

  async listUsers(orgId: string, params: ListUsersInput) {
    return this.reader.listUsers(orgId, params);
  }

  async getUser(orgId: string, userId: string) {
    return this.reader.getUser(orgId, userId);
  }

  private assertMayGrantRole(
    orgId: string,
    actor: InviteActor,
    role: string,
  ): Promise<void> {
    return assertMayGrantRole(this.access, orgId, actor, role);
  }

  async updateUser(
    orgId: string,
    userId: string,
    data: UpdateUserInput,
    actor: InviteActor,
  ) {
    const actorUserId = actor.userId;
    await this.getUser(orgId, userId);
    if (data.role !== undefined)
      await this.assertMayGrantRole(orgId, actor, data.role);

    if (data.reportingTo) {
      const manager = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, data.reportingTo),
          eq(organizationMembers.status, "ACTIVE"),
        ),
        columns: { userId: true },
      });
      if (!manager)
        throw new BadRequestException(
          "Manager must be an active member of this organization",
        );
    }

    const updateData: Record<string, unknown> = {};
    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { firstName: true, lastName: true },
      });
      const first = data.firstName ?? user?.firstName ?? "";
      const last = data.lastName ?? user?.lastName ?? "";
      updateData.name = `${first} ${last}`.trim();
    }
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.linkedinUrl !== undefined)
      updateData.linkedinUrl = data.linkedinUrl || null;
    if (data.twitterUrl !== undefined)
      updateData.twitterUrl = data.twitterUrl || null;
    if (data.githubUrl !== undefined)
      updateData.githubUrl = data.githubUrl || null;
    if (data.websiteUrl !== undefined)
      updateData.websiteUrl = data.websiteUrl || null;
    if (data.emergencyContact !== undefined)
      updateData.emergencyContact = data.emergencyContact;

    const hasUserUpdates = Object.keys(updateData).length > 0;
    const hasPlacementUpdates =
      data.departmentId !== undefined || data.teamId !== undefined;
    const hasReportingUpdate = data.reportingTo !== undefined;

    let canonicalEmploymentSynced: boolean | null = null;
    if (hasUserUpdates || hasPlacementUpdates || hasReportingUpdate) {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          if (hasUserUpdates) {
            await tx.update(users).set(updateData).where(eq(users.id, userId));
          }
          await syncOrgUnitPlacement(tx, orgId, userId, {
            DEPARTMENT: data.departmentId,
            TEAM: data.teamId,
          });
          if (
            data.designation !== undefined ||
            data.departmentId !== undefined
          ) {
            canonicalEmploymentSynced = await syncCanonicalEmploymentFields(
              tx,
              orgId,
              userId,
              {
                designation: data.designation,
                departmentId: data.departmentId,
              },
            );
          }
          if (hasReportingUpdate) {
            const today = new Date().toISOString().slice(0, 10);
            await syncCanonicalReportingLine(tx, orgId, userId, data.reportingTo ?? null, today, actorUserId);
          }
        },
        { orgId },
      );
    }

    if (data.role !== undefined) {
      const nextRole = data.role;
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await assertTargetNotOwner(tx, orgId, userId);
          const [member] = await tx
            .update(organizationMembers)
            .set({ role: nextRole })
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, userId),
              ),
            )
            .returning({ id: organizationMembers.id });
          if (member) {
            await syncStructuralRoleAssignment(tx, orgId, member.id, nextRole);
          }
        },
        { orgId },
      );
      await bustMembershipStatusCache(this.cache, userId, orgId);
    }

    this.audit.log({
      action: "user.updated",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
      metadata: {
        changes: data,
        ...(canonicalEmploymentSynced !== null && {
          canonicalEmploymentSynced,
        }),
      },
    });

    return { success: true };
  }

  async updateUserStatus(
    orgId: string,
    userId: string,
    status: MemberLifecycleStatus,
    actorUserId: string,
    reason?: string,
  ) {
    return this.orgMembership.setMemberLifecycleStatus(
      orgId,
      actorUserId,
      userId,
      status,
      {
        reason,
        auditAction: `user.status.${status}`,
      },
    );
  }

  async deleteUser(orgId: string, userId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    const membershipCount = await withIdentity(this.db, userId, async (tx) => {
      const [row] = await tx
        .select({ total: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, userId));
      return row?.total ?? 0;
    });

    if (membershipCount > 1) {
      throw new BadRequestException(
        "This user belongs to multiple organizations. Remove them from this organization instead of deleting the account.",
      );
    }

    await this.orgMembership.removeMember(orgId, actorUserId, userId);
    await this.orgMembership.revokeAccountAccess(orgId, userId);

    await this.db
      .update(users)
      .set({ isActive: false, userStatus: "deleted", deletedAt: new Date() })
      .where(eq(users.id, userId));

    await bustMembershipStatusCache(this.cache, userId);
    await this.invalidateMembershipCaches(orgId);

    this.audit.log({
      action: "user.deleted",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
    });

    return { success: true };
  }
}

