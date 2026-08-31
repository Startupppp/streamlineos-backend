import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { InviteActor } from "./invitations.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { assertTargetNotOwner } from "../../../common/rbac/assert-target-not-owner";
import { assertNotLastStructuralAdmin } from "../../../common/rbac/assert-not-last-structural-admin";
import { AccessService } from "../../access/access.service";
import { and, eq } from "drizzle-orm";
import { organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { SessionsService } from "../../sessions/sessions.service";
import { stableHash } from "../../../common/cache/cache-hash";
import type { ListMembersInput } from "./dto/organization.schemas";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AblyService } from "../../realtime/ably.service";
import { OrgMembershipReadService } from "./org-membership-read.service";
import {
  OrgMembershipAccessRevocation,
  type MembershipRevocationCause,
} from "./org-membership-access-revocation";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { queryOwnedModuleKeys } from "./org-member-authority-queries";
import type { MemberLifecycleStatus } from "./member-lifecycle.types";

export type { MemberLifecycleStatus } from "./member-lifecycle.types";
export { membershipStatusToUserStatus, userStatusToMembershipStatus } from "./member-lifecycle.types";
export type { MembershipRevocationCause } from "./org-membership-access-revocation";

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
    private readonly membershipRead: OrgMembershipReadService,
    private readonly membershipStatus: OrgMembershipStatusService,
    private readonly memberDeparture: OrgMemberDepartureService,
  ) {
    this.accessRevocation = new OrgMembershipAccessRevocation(
      ably,
      db,
      cache,
      sessions,
      email,
    );
  }

  private readonly accessRevocation: OrgMembershipAccessRevocation;

  async revokeOrgScopedAccess(
    orgId: string,
    memberUserId: string,
    cause: MembershipRevocationCause,
  ): Promise<void> {
    return this.accessRevocation.revokeOrgScopedAccess(orgId, memberUserId, cause);
  }

  async revokeAccountAccess(orgId: string, memberUserId: string): Promise<void> {
    return this.accessRevocation.revokeAccountAccess(orgId, memberUserId);
  }

  private async notifyAccessLoss(
    orgId: string,
    memberUserId: string,
    kind: "removed" | "suspended",
  ): Promise<void> {
    return this.accessRevocation.notifyAccessLoss(orgId, memberUserId, kind);
  }

  private async invalidateMemberSessionCaches(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    return this.accessRevocation.invalidateMemberSessionCaches(orgId, memberUserId);
  }

  private async invalidateMemberListCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
      this.cache.invalidateForOrg(orgId, "rbac:members"),
      this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      this.cache.invalidateForOrg(orgId, "users:stats"),
    ]);
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
    return this.cache.cachedVersionedForOrg(
      orgId,
      "org:members:list",
      hash,
      () => this.membershipRead.list(orgId, page, limit, search, userIds, includeInactive),
      60,
    );
  }

  async setMemberLifecycleStatus(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
    status: MemberLifecycleStatus,
    options?: { reason?: string; auditAction?: string },
  ) {
    return this.membershipStatus.setMemberLifecycleStatus(
      orgId,
      actorUserId,
      memberUserId,
      status,
      options,
    );
  }

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.memberDeparture.removeMember(orgId, actorUserId, memberUserId);
  }

  async leaveOrg(orgId: string, userId: string) {
    return this.memberDeparture.leaveOrg(orgId, userId);
  }

  async suspendMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.membershipStatus.suspendMember(orgId, actorUserId, memberUserId);
  }

  async reactivateMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.membershipStatus.reactivateMember(orgId, actorUserId, memberUserId);
  }

  async updateMemberRole(
    orgId: string,
    actor: InviteActor,
    memberUserId: string,
    role: string,
  ) {
    const actorUserId = actor.userId;

    await assertMayGrantRole(this.access, orgId, actor, role);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await assertTargetNotOwner(tx, orgId, memberUserId);
        const [member] = await tx
          .select({
            id: organizationMembers.id,
            role: organizationMembers.role,
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

        await assertNotLastStructuralAdmin(tx, orgId, member.id, member.role, role);

        const ownedModuleKeys = await queryOwnedModuleKeys(tx, orgId, member.id);
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
      this.cache.invalidateNamespaceForOrg(orgId, "org:profile"),
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

    return { success: true };
  }
}
