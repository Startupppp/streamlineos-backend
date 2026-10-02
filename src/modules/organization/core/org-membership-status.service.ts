import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  accountOrganizationIndex,
  organizationMembers,
  orgUnitMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  OrgMembershipAccessRevocation,
  type OrgScopedRevocation,
} from "./org-membership-access-revocation";
import type { DispatchEventInput } from "../../notifications/notification.types";
import {
  queryOwnedModuleKeys,
  queryPrivilegedRoleNames,
} from "./org-member-authority-queries";
import {
  membershipStatusToUserStatus,
  type MemberLifecycleStatus,
  userStatusToMembershipStatus,
} from "./member-lifecycle.types";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { AblyService } from "../../realtime/ably.service";
import {
  planLastActiveOrganizationChange,
  applyLastActiveOrganizationChange,
} from "./org-membership-last-active-org";

function restoredStanding(memberUserId: string): OrgScopedRevocation {
  return {
    loses: [{ kind: "standing", userIds: [memberUserId] }],
    afterCommit: () => Promise.resolve(),
  };
}

function reactivatedEvent(
  orgId: string,
  actorUserId: string,
  memberUserId: string,
): DispatchEventInput {
  return {
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
  };
}

@Injectable()
export class OrgMembershipStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly ably: AblyService,
    private readonly sessions: SessionsService,
    private readonly email: EmailService,
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

    const lastActiveOrgChange = await planLastActiveOrganizationChange(
      this.db,
      memberUserId,
      orgId,
      status,
    );

    await withMembershipMutations((membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          if (status !== "active") {
            const ownedModuleKeys = await queryOwnedModuleKeys(tx, orgId, member.id);
            if (ownedModuleKeys.length > 0) {
              throw new BadRequestException(
                `Transfer module ownership before this action. Owned modules: ${ownedModuleKeys.join(", ")}.`,
              );
            }

            const privilegedRoles = await queryPrivilegedRoleNames(tx, orgId, member.id);
            if (privilegedRoles.length > 0) {
              throw new BadRequestException(
                `Remove administrative role(s) before this action: ${privilegedRoles.join(", ")}.`,
              );
            }

            await tx
              .delete(orgUnitMembers)
              .where(
                and(
                  eq(orgUnitMembers.membershipId, member.id),
                  eq(orgUnitMembers.orgId, orgId),
                ),
              );
          }

          await applyLastActiveOrganizationChange(tx, memberUserId, lastActiveOrgChange);

          const revocation =
            status === "active"
              ? restoredStanding(memberUserId)
              : await this.accessRevocation.planOrgScopedRevocation(
                  tx,
                  orgId,
                  memberUserId,
                  status,
                );
          await membership.setLifecycleStatus(
            tx,
            { orgId, userId: memberUserId, status: membershipStatus, occurredAt: now },
            {
              audit: {
                action: options?.auditAction ?? `user.status.${status}`,
                userId: actorUserId,
                targetId: memberUserId,
                targetType: "user",
                resourceType: "user",
                resourceId: memberUserId,
                metadata: { status, reason: options?.reason },
              },
              revoke: { cache: this.cache, loses: revocation.loses },
              notify: {
                via: this.dispatch,
                events: status === "active" ? [reactivatedEvent(orgId, actorUserId, memberUserId)] : [],
              },
              afterCommit: () =>
                Promise.all([
                  revocation.afterCommit(),
                  status === "active"
                    ? undefined
                    : this.accessRevocation.notifyAccessLoss(
                        orgId,
                        memberUserId,
                        status === "suspended" ? "suspended" : "removed",
                      ),
                  this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
                  this.cache.invalidateForOrg(orgId, "rbac:members"),
                ]).then(() => undefined),
            },
          );
        },
        { orgId },
      ),
    );

    await this.db
      .update(accountOrganizationIndex)
      .set({ membershipStatus: userStatusToMembershipStatus(status) })
      .where(
        and(
          eq(accountOrganizationIndex.userId, memberUserId),
          eq(accountOrganizationIndex.orgId, orgId),
        ),
      );

    return { success: true };
  }

  async suspendMember(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
  ) {
    return this.setMemberLifecycleStatus(orgId, actorUserId, memberUserId, "suspended", {
      auditAction: "org.member_suspended",
    });
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
    return this.setMemberLifecycleStatus(orgId, actorUserId, memberUserId, "active", {
      auditAction: "org.member_reactivated",
    });
  }
}
