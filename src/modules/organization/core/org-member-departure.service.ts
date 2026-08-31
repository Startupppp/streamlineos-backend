import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
  orgUnitMembers,
  ownershipTransfers,
  userDelegations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { getOrgAdminUserIds } from "../../../common/tenant/org-admin-recipients";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { AblyService } from "../../realtime/ably.service";
import { OrgMembershipAccessRevocation } from "./org-membership-access-revocation";
import {
  queryOwnedModuleKeys,
  queryPrivilegedRoleNames,
} from "./org-member-authority-queries";

const PG_FK_VIOLATION = "23503";

@Injectable()
export class OrgMemberDepartureService {
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

          const ownedModuleKeys = await queryOwnedModuleKeys(tx, orgId, member.id);
          if (ownedModuleKeys.length > 0) {
            throw new BadRequestException(
              `Transfer module ownership before removing this member. Owned modules: ${ownedModuleKeys.join(", ")}.`,
            );
          }

          const privilegedRoles = await queryPrivilegedRoleNames(tx, orgId, member.id);
          if (privilegedRoles.length > 0) {
            throw new BadRequestException(
              `Remove administrative role(s) before removing this member: ${privilegedRoles.join(", ")}.`,
            );
          }

          const removalNow = new Date();

          await tx
            .delete(ownershipTransfers)
            .where(
              and(
                eq(ownershipTransfers.orgId, orgId),
                or(
                  eq(ownershipTransfers.fromMembershipId, member.id),
                  eq(ownershipTransfers.toMembershipId, member.id),
                  eq(ownershipTransfers.initiatedByMembershipId, member.id),
                ),
              ),
            );

          await tx
            .update(userDelegations)
            .set({ status: "REVOKED", revokedAt: removalNow })
            .where(
              and(
                eq(userDelegations.orgId, orgId),
                eq(userDelegations.status, "ACTIVE"),
                or(
                  eq(userDelegations.delegatorMembershipId, member.id),
                  eq(userDelegations.delegateeMembershipId, member.id),
                ),
              ),
            );

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

    await this.accessRevocation.revokeOrgScopedAccess(orgId, memberUserId, "removed");
    await this.db
      .delete(accountOrganizationIndex)
      .where(
        and(
          eq(accountOrganizationIndex.userId, memberUserId),
          eq(accountOrganizationIndex.orgId, orgId),
        ),
      );
    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
      this.cache.invalidateForOrg(orgId, "rbac:members"),
      this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      this.cache.invalidateForOrg(orgId, "users:stats"),
    ]);

    this.audit.log({
      action: "org.member_removed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    await this.accessRevocation
      .notifyAccessLoss(orgId, memberUserId, "removed")
      .catch(() => undefined);

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
          const ownedModuleKeys = await queryOwnedModuleKeys(tx, orgId, membership.id);
          if (ownedModuleKeys.length > 0) {
            throw new BadRequestException(
              `Transfer module ownership before leaving this organization. Owned modules: ${ownedModuleKeys.join(", ")}.`,
            );
          }

          const leaveNow = new Date();

          await tx
            .delete(ownershipTransfers)
            .where(
              and(
                eq(ownershipTransfers.orgId, orgId),
                or(
                  eq(ownershipTransfers.fromMembershipId, membership.id),
                  eq(ownershipTransfers.toMembershipId, membership.id),
                  eq(ownershipTransfers.initiatedByMembershipId, membership.id),
                ),
              ),
            );

          await tx
            .update(userDelegations)
            .set({ status: "REVOKED", revokedAt: leaveNow })
            .where(
              and(
                eq(userDelegations.orgId, orgId),
                eq(userDelegations.status, "ACTIVE"),
                or(
                  eq(userDelegations.delegatorMembershipId, membership.id),
                  eq(userDelegations.delegateeMembershipId, membership.id),
                ),
              ),
            );

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
        this.accessRevocation.revokeOrgScopedAccess(orgId, userId, "left"),
        this.cache.invalidateNamespaceForOrg(orgId, "org:profile"),
        this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
        this.cache.invalidateForOrg(orgId, "rbac:members"),
        this.cache.invalidateForOrg(orgId, "module-access:candidates"),
        this.cache.invalidateForOrg(orgId, "users:stats"),
        this.db
          .delete(accountOrganizationIndex)
          .where(
            and(
              eq(accountOrganizationIndex.userId, userId),
              eq(accountOrganizationIndex.orgId, orgId),
            ),
          ),
      ]);
      this.audit.log({
        action: "org.member_left",
        userId,
        orgId,
        targetId: userId,
        targetType: "user",
      });

      await this.notifyMemberLeft(orgId, userId).catch(() => undefined);

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
