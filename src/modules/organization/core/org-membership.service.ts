import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { InviteActor } from "./invitations.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { assertTargetNotOwner } from "../../../common/rbac/assert-target-not-owner";
import { AccessService } from "../../access/access.service";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import {
  agentTokens,
  moduleOwnerships,
  roleAssignments,
  roles,
  orgUnitMembers,
  organizationMembers,
  organizations,
  userApiTokens,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustUsersStatsCache } from "../../../common/cache/bust-users-stats";
import {
  bumpPermissionsVersion,
  type DbOrTx,
} from "../../../common/rbac/access-invalidate";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { SessionsService } from "../../sessions/sessions.service";
import { stableHash } from "../../../common/cache/cache-hash";
import type { ListMembersInput } from "./dto/organization.schemas";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import {
  registerAfterCommit,
  runOutsideTenantContext,
} from "../../../common/tenant/tenant-context";
import { getOrgAdminUserIds } from "../../../common/tenant/org-admin-recipients";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AblyService } from "../../realtime/ably.service";

const PG_FK_VIOLATION = "23503";

export type MemberLifecycleStatus = "active" | "suspended" | "archived";

export function membershipStatusToUserStatus(
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "LEFT",
): MemberLifecycleStatus {
  if (status === "SUSPENDED") return "suspended";
  if (status === "LEFT") return "archived";
  return "active";
}

export function userStatusToMembershipStatus(
  status: MemberLifecycleStatus,
): "ACTIVE" | "SUSPENDED" | "LEFT" {
  if (status === "suspended") return "SUSPENDED";
  if (status === "archived") return "LEFT";
  return "ACTIVE";
}

@Injectable()
export class OrgMembershipService {
  constructor(
    private readonly ably: AblyService,
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private readonly logger = new Logger(OrgMembershipService.name);

  /**
   * Access-loss notices cannot go through the dispatch engine: `filterOrgMemberIds`
   * only resolves ACTIVE memberships, so a removed or suspended member is silently
   * dropped. Email is the only channel that still reaches them.
   */
  private async notifyAccessLoss(
    orgId: string,
    memberUserId: string,
    kind: "removed" | "suspended",
  ): Promise<void> {
    const [member, org] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, memberUserId),
        columns: { email: true, name: true, firstName: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);
    if (!member?.email || !org) return;

    const displayName = member.firstName ?? member.name ?? member.email;
    void (
      kind === "removed"
        ? this.email.sendMembershipRemovedEmail(
            member.email,
            displayName,
            org.name,
          )
        : this.email.sendMembershipSuspendedEmail(
            member.email,
            displayName,
            org.name,
          )
    ).catch((err: unknown) => {
      this.logger.warn(
        `Access ${kind} notice not delivered for user ${memberUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async revokeOrgScopedAccess(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.invalidateMemberSessionCaches(orgId, memberUserId);
    const now = new Date();
    await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(agentTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(agentTokens.userId, memberUserId),
              eq(agentTokens.orgId, orgId),
              isNull(agentTokens.revokedAt),
            ),
          ),
      { orgId },
    );
  }

  async revokeAccountAccess(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.revokeOrgScopedAccess(orgId, memberUserId);
    await this.sessions.revokeAllForUser(memberUserId);
    const now = new Date();
    await this.db
      .update(userApiTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(userApiTokens.userId, memberUserId),
          isNull(userApiTokens.revokedAt),
        ),
      );
  }

  private async invalidateMemberListCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.orgMembersListNamespace(orgId)),
      this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessCandidates(orgId)),
      bustUsersStatsCache(this.cache, orgId),
    ]);
  }

  private async invalidateMemberSessionCaches(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    const invalidate = () =>
      Promise.all([
        this.cache.invalidate(CACHE_KEYS.userSession(memberUserId)),
        bustMembershipStatusCache(this.cache, memberUserId, orgId),
      ]).then(() => undefined);

    // Invalidate immediately to close access quickly, then again after the
    // request transaction commits. Without the second bust, a concurrent MVCC
    // reader can repopulate ACTIVE state between this call and commit.
    await invalidate();
    registerAfterCommit(invalidate);
  }

  /**
   * Plan the user's selected organization from an identity-scoped view of all
   * their memberships. This is intentionally calculated before the tenant
   * mutation so RLS can see active sibling organizations without weakening the
   * organization-scoped write transaction.
   */
  private async planLastActiveOrganizationChange(
    userId: string,
    affectedOrgId: string,
    nextStatus: MemberLifecycleStatus,
  ): Promise<{
    previousOrgId: string | null;
    nextOrgId: string | null;
  } | null> {
    // Keep a suspended selected org as the preference. Recovery will explain
    // the suspension and offer active siblings instead of silently changing
    // the person's workspace.
    if (nextStatus === "suspended") return null;

    // The injected DB is tenant-aware. Exit the ambient admin transaction so
    // app.user_id is scoped to a separate identity transaction and cannot
    // survive a nested savepoint or widen later RLS reads in this request.
    const rows = await runOutsideTenantContext(() =>
      withIdentity(this.db, userId, (tx) =>
        tx
          .select({
            previousOrgId: users.lastActiveOrgId,
            activeOrgId: organizations.id,
          })
          .from(users)
          .leftJoin(
            organizationMembers,
            and(
              eq(organizationMembers.userId, users.id),
              eq(organizationMembers.status, "ACTIVE"),
            ),
          )
          .leftJoin(
            organizations,
            and(
              eq(organizations.id, organizationMembers.orgId),
              eq(organizations.status, "ACTIVE"),
              isNull(organizations.deletedAt),
            ),
          )
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .orderBy(desc(organizationMembers.joinedAt)),
      ),
    );

    if (rows.length === 0) return null;

    const previousOrgId = rows[0]?.previousOrgId ?? null;
    const activeOrgIds = rows
      .map((row) => row.activeOrgId)
      .filter((orgId): orgId is string => typeof orgId === "string");
    const eligibleOrgIds =
      nextStatus === "active"
        ? [affectedOrgId, ...activeOrgIds.filter((id) => id !== affectedOrgId)]
        : activeOrgIds.filter((id) => id !== affectedOrgId);

    // Restoration should add an option, not pull someone away from another
    // organization where they are already working.
    if (previousOrgId && eligibleOrgIds.includes(previousOrgId)) return null;

    return {
      previousOrgId,
      nextOrgId: eligibleOrgIds[0] ?? null,
    };
  }

  private async applyLastActiveOrganizationChange(
    tx: DbOrTx,
    userId: string,
    change: {
      previousOrgId: string | null;
      nextOrgId: string | null;
    } | null,
  ): Promise<void> {
    if (!change) return;

    await tx
      .update(users)
      .set({ lastActiveOrgId: change.nextOrgId })
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          change.previousOrgId === null
            ? isNull(users.lastActiveOrgId)
            : eq(users.lastActiveOrgId, change.previousOrgId),
        ),
      );
  }

  private async queryOwnedModuleKeys(
    db: DbOrTx,
    orgId: string,
    membershipId: number,
  ): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: moduleOwnerships.moduleKey })
      .from(moduleOwnerships)
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.ownerMembershipId, membershipId),
        ),
      )
      .for("update");
    return rows.map((r) => r.moduleKey);
  }

  private async queryPrivilegedRoleNames(
    db: DbOrTx,
    orgId: string,
    membershipId: number,
  ): Promise<string[]> {
    const rows = await db
      .select({ name: roles.name })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(
          eq(roleAssignments.roleId, roles.id),
          eq(roleAssignments.orgId, roles.orgId),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(roleAssignments.organizationMembershipId, membershipId),
          lte(roles.rank, ROLE_RANK.MODULE_ADMIN),
        ),
      );
    return rows.map((r) => r.name);
  }

  async listMembers(orgId: string, input: ListMembersInput) {
    const { page, search, userIds } = input;
    const limit = Math.min(input.limit, 100);
    const includeInactive = input.includeInactive === true;
    const hash = stableHash({
      page,
      limit,
      search: search ?? null,
      userIds: userIds ? [...userIds].sort() : null,
      includeInactive,
    });
    return this.cache.cachedVersioned(
      CACHE_KEYS.orgMembersListNamespace(orgId),
      hash,
      () =>
        this.fetchMembers(orgId, page, limit, search, userIds, includeInactive),
      60,
    );
  }

  private async fetchMembers(
    orgId: string,
    page: number,
    limit: number,
    search: string | undefined,
    userIds: string[] | undefined,
    includeInactive: boolean,
  ) {
    const offset = (page - 1) * limit;
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
    if (!includeInactive) {
      baseConditions.push(eq(organizationMembers.status, "ACTIVE"));
    }
    if (userIds && userIds.length > 0) {
      baseConditions.push(inArray(organizationMembers.userId, userIds));
    }
    const searchConditions = search
      ? [
          ...baseConditions,
          or(
            ilike(users.name, `%${search}%`),
            ilike(users.email, `%${search}%`),
          ),
        ]
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
        .where(and(...searchConditions))
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...searchConditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: dataResult,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    try {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [member] = await tx
            .select({
              isOwner: organizationMembers.isOwner,
              id: organizationMembers.id,
            })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.userId, memberUserId),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .for("update")
            .limit(1);

          if (!member) throw new NotFoundException("Member not found");
          if (member.isOwner) {
            throw new BadRequestException(
              "Cannot remove the organization owner. Transfer ownership first.",
            );
          }

          const ownedModuleKeys = await this.queryOwnedModuleKeys(
            tx,
            orgId,
            member.id,
          );
          if (ownedModuleKeys.length > 0) {
            throw new BadRequestException(
              `Transfer module ownership before removing this member. Owned modules: ${ownedModuleKeys.join(", ")}.`,
            );
          }

          const privilegedRoles = await this.queryPrivilegedRoleNames(
            tx,
            orgId,
            member.id,
          );
          if (privilegedRoles.length > 0) {
            throw new BadRequestException(
              `Remove administrative role(s) before removing this member: ${privilegedRoles.join(", ")}.`,
            );
          }

          await tx
            .delete(organizationMembers)
            .where(
              and(
                eq(organizationMembers.userId, memberUserId),
                eq(organizationMembers.orgId, orgId),
              ),
            );

          await tx
            .delete(orgUnitMembers)
            .where(
              and(
                eq(orgUnitMembers.userId, memberUserId),
                eq(orgUnitMembers.orgId, orgId),
              ),
            );

          await bumpPermissionsVersion(tx, orgId);
        },
        { orgId },
      );
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      )
        throw err;
      if ((err as { code?: string }).code === PG_FK_VIOLATION) {
        throw new BadRequestException(
          "Cannot remove a member who owns a module. Transfer module ownership first.",
        );
      }
      throw err;
    }

    await this.revokeOrgScopedAccess(orgId, memberUserId);
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: "org.member_removed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    await this.notifyAccessLoss(orgId, memberUserId, "removed").catch(() => undefined);

      // RT-006: Ably tokens are 1-hour TTL and were never revoked, so a removed or
      // suspended member kept a live realtime connection after losing access.
      // Revocation is post-commit and its failure is swallowed inside the service —
      // realtime cleanup must never roll back an access revocation.
    void this.ably.revokeUserTokens(memberUserId);
    return { success: true };
  }

  async setMemberLifecycleStatus(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
    status: MemberLifecycleStatus,
    options?: { reason?: string; auditAction?: string },
  ) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, memberUserId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { isOwner: true, status: true, id: true },
    });
    if (!member) throw new NotFoundException("Member not found");

    const current = membershipStatusToUserStatus(member.status);
    if (status !== "active" && member.isOwner) {
      throw new BadRequestException(
        `The organization owner cannot be ${status}. Transfer ownership to another member first.`,
      );
    }
    if (current === "archived" && status === "suspended") {
      throw new BadRequestException(
        "Cannot suspend an archived user. Restore the user first.",
      );
    }
    if (status === "suspended" && current === "suspended") {
      throw new ConflictException("Member is already suspended");
    }
    if (status === "archived" && current === "archived") {
      throw new ConflictException("Member is already archived");
    }
    if (status === "active" && current === "active") {
      return { success: true };
    }

    const membershipStatus = userStatusToMembershipStatus(status);
    const now = new Date();
    const membershipUpdate =
      status === "active"
        ? {
            status: membershipStatus,
            activatedAt: now,
            suspendedAt: null,
            leftAt: null,
          }
        : status === "suspended"
          ? {
              status: membershipStatus,
              suspendedAt: now,
              leftAt: null,
            }
          : {
              status: membershipStatus,
              leftAt: now,
              suspendedAt: null,
            };

    const lastActiveOrgChange = await this.planLastActiveOrganizationChange(
      memberUserId,
      orgId,
      status,
    );

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        if (status !== "active") {
          const ownedModuleKeys = await this.queryOwnedModuleKeys(
            tx,
            orgId,
            member.id,
          );
          if (ownedModuleKeys.length > 0) {
            throw new BadRequestException(
              `Transfer module ownership before this action. Owned modules: ${ownedModuleKeys.join(", ")}.`,
            );
          }

          const privilegedRoles = await this.queryPrivilegedRoleNames(
            tx,
            orgId,
            member.id,
          );
          if (privilegedRoles.length > 0) {
            throw new BadRequestException(
              `Remove administrative role(s) before this action: ${privilegedRoles.join(", ")}.`,
            );
          }
        }

        await tx
          .update(organizationMembers)
          .set(membershipUpdate)
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          );
        if (status !== "active") {
          await tx
            .delete(orgUnitMembers)
            .where(
              and(
                eq(orgUnitMembers.userId, memberUserId),
                eq(orgUnitMembers.orgId, orgId),
              ),
            );
        }

        // Keep global account activation untouched. A membership restore must
        // never undo an independent account/HR deactivation.
        await this.applyLastActiveOrganizationChange(
          tx,
          memberUserId,
          lastActiveOrgChange,
        );

        await bumpPermissionsVersion(tx, orgId);
      },
      { orgId },
    );

    if (status !== "active") {
      await this.revokeOrgScopedAccess(orgId, memberUserId);
    } else {
      await this.invalidateMemberSessionCaches(orgId, memberUserId);
    }
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: options?.auditAction ?? `user.status.${status}`,
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: memberUserId,
      metadata: { status, reason: options?.reason },
    });

    if (status === "active") {
      void this.dispatch
        .emit({
          eventKey: "organization.member.reactivated",
          orgId,
          actorUserId,
          targetUserIds: [memberUserId],
          entityType: "user",
          entityId: memberUserId,
          title: "Your access was restored",
          message:
            "An administrator restored your membership. You can sign in to this organization again.",
          link: "/dashboard",
        })
        .catch(() => undefined);
    } else {
      await this.notifyAccessLoss(
        orgId,
        memberUserId,
        status === "suspended" ? "suspended" : "removed",
      ).catch(() => undefined);
    }

    return { success: true };
  }

  async suspendMember(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
  ) {
    return this.setMemberLifecycleStatus(
      orgId,
      actorUserId,
      memberUserId,
      "suspended",
      {
        auditAction: "org.member_suspended",
      },
    );
  }

  async reactivateMember(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
  ) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, memberUserId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { status: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.status !== "SUSPENDED") {
      throw new ConflictException("Member is not suspended");
    }
    return this.setMemberLifecycleStatus(
      orgId,
      actorUserId,
      memberUserId,
      "active",
      {
        auditAction: "org.member_reactivated",
      },
    );
  }

  async updateMemberRole(
    orgId: string,
    actor: InviteActor,
    memberUserId: string,
    role: string,
  ) {
    const actorUserId = actor.userId;

    await assertMayGrantRole(this.db, orgId, actor, role);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await assertTargetNotOwner(tx, orgId, memberUserId);
        const [member] = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          )
          .for("update")
          .limit(1);

        if (!member) throw new NotFoundException("Member not found");

        const ownedModuleKeys = await this.queryOwnedModuleKeys(
          tx,
          orgId,
          member.id,
        );
        if (ownedModuleKeys.length > 0) {
          throw new BadRequestException(
            `Transfer module ownership before changing this member's role. Owned modules: ${ownedModuleKeys.join(", ")}.`,
          );
        }

        await tx
          .update(organizationMembers)
          .set({ role })
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          );

        await syncStructuralRoleAssignment(tx, orgId, member.id, role);
      },
      { orgId },
    );

    await Promise.all([
      this.invalidateMemberListCaches(orgId),
      this.cache.invalidateNamespace(CACHE_KEYS.orgProfileNamespace(orgId)),
      bustMembershipStatusCache(this.cache, memberUserId, orgId),
    ]);

    this.audit.log({
      action: "org.member_role_changed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
      metadata: { newRole: role },
    });

    void this.dispatch
      .emit({
        eventKey: "security.role.changed",
        orgId,
        actorUserId,
        targetUserIds: [memberUserId],
        entityType: "user",
        entityId: memberUserId,
        title: "Your role or permissions were updated",
        message: `Your organization role is now ${role}. Your access permissions may have changed.`,
        link: "/settings/security",
      })
      .catch(() => undefined);

      // RT-006: Ably tokens are 1-hour TTL and were never revoked, so a removed or
      // suspended member kept a live realtime connection after losing access.
      // Revocation is post-commit and its failure is swallowed inside the service —
      // realtime cleanup must never roll back an access revocation.
    void this.ably.revokeUserTokens(memberUserId);
    return { success: true };
  }

  async leaveOrg(orgId: string, userId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { isOwner: true, id: true },
    });
    if (!membership) {
      throw new BadRequestException(
        "You are not a member of this organization",
      );
    }
    if (membership.isOwner) {
      throw new BadRequestException(
        "Owners cannot leave. Transfer ownership to another member or delete the organization.",
      );
    }

    try {
      const nextOrgId = await runInTenantTransaction(
        this.db,
        async (tx) => {
          const ownedModuleKeys = await this.queryOwnedModuleKeys(
            tx,
            orgId,
            membership.id,
          );
          if (ownedModuleKeys.length > 0) {
            throw new BadRequestException(
              `Transfer module ownership before leaving this organization. Owned modules: ${ownedModuleKeys.join(", ")}.`,
            );
          }

          await tx
            .delete(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, userId),
              ),
            );

          await tx
            .delete(orgUnitMembers)
            .where(
              and(
                eq(orgUnitMembers.userId, userId),
                eq(orgUnitMembers.orgId, orgId),
              ),
            );

          await bumpPermissionsVersion(tx, orgId);

          const [remaining] = await tx
            .select({ orgId: organizationMembers.orgId })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              eq(organizations.id, organizationMembers.orgId),
            )
            .where(
              and(
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "ACTIVE"),
                eq(organizations.status, "ACTIVE"),
                isNull(organizations.deletedAt),
              ),
            )
            .orderBy(desc(organizationMembers.joinedAt))
            .limit(1);
          const fallbackOrgId = remaining?.orgId ?? null;
          await tx
            .update(users)
            .set({ lastActiveOrgId: fallbackOrgId })
            .where(and(eq(users.id, userId), eq(users.lastActiveOrgId, orgId)));
          return fallbackOrgId;
        },
        { orgId },
      );

      await Promise.all([
        this.revokeOrgScopedAccess(orgId, userId),
        this.cache.invalidateNamespace(CACHE_KEYS.orgProfileNamespace(orgId)),
        this.invalidateMemberListCaches(orgId),
      ]);
      this.audit.log({
        action: "org.member_left",
        userId,
        orgId,
        targetId: userId,
        targetType: "user",
      });

      await this.notifyMemberLeft(orgId, userId).catch(() => undefined);

      // RT-006: Ably tokens are 1-hour TTL and were never revoked, so a removed or
      // suspended member kept a live realtime connection after losing access.
      // Revocation is post-commit and its failure is swallowed inside the service —
      // realtime cleanup must never roll back an access revocation.
      void this.ably.revokeUserTokens(userId);
      return { success: true, nextOrgId };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if ((err as { code?: string }).code === PG_FK_VIOLATION) {
        throw new BadRequestException(
          "Cannot leave an organization while owning a module. Transfer module ownership first.",
        );
      }
      throw err;
    }
  }

  private async notifyMemberLeft(orgId: string, userId: string): Promise<void> {
    const [admins, member] = await Promise.all([
      getOrgAdminUserIds(this.db, orgId),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true, name: true },
      }),
    ]);
    if (admins.length === 0) return;

    await this.dispatch.emit({
      eventKey: "organization.member.left",
      orgId,
      actorUserId: userId,
      targetUserIds: admins,
      entityType: "user",
      entityId: userId,
      title: "A member left the organization",
      message: `${member?.name ?? member?.email ?? "A member"} left the organization. Their seat is now free.`,
      link: "/users",
    });
  }
}
