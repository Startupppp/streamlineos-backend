import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
  orgUnitMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import {
  bumpPermissionsVersion,
  type DbOrTx,
} from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { runOutsideTenantContext } from "../../../common/tenant/tenant-context";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  OrgMembershipAccessRevocation,
  type MembershipRevocationCause,
} from "./org-membership-access-revocation";
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

@Injectable()
export class OrgMembershipStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
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

  private async planLastActiveOrganizationChange(
    userId: string,
    affectedOrgId: string,
    nextStatus: MemberLifecycleStatus,
  ): Promise<{
    previousOrgId: string | null;
    nextOrgId: string | null;
  } | null> {
    if (nextStatus === "suspended") return null;

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

        await this.applyLastActiveOrganizationChange(tx, memberUserId, lastActiveOrgChange);
        await bumpPermissionsVersion(tx, orgId);
      },
      { orgId },
    );

    if (status !== "active") {
      await this.accessRevocation.revokeOrgScopedAccess(orgId, memberUserId, status as MembershipRevocationCause);
    } else {
      await this.accessRevocation.invalidateMemberSessionCaches(orgId, memberUserId);
    }
    await this.db
      .update(accountOrganizationIndex)
      .set({ membershipStatus: userStatusToMembershipStatus(status) })
      .where(
        and(
          eq(accountOrganizationIndex.userId, memberUserId),
          eq(accountOrganizationIndex.orgId, orgId),
        ),
      );
    await this.cache.invalidateNamespaceForOrg(orgId, "org:members:list");
    await this.cache.invalidateForOrg(orgId, "rbac:members");

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
      await this.accessRevocation
        .notifyAccessLoss(orgId, memberUserId, status === "suspended" ? "suspended" : "removed")
        .catch(() => undefined);
    }

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
