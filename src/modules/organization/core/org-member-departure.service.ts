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
import { CacheService } from "../../../common/cache/cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { getOrgAdminUserIds } from "../../../common/tenant/org-admin-recipients";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { DispatchEventInput } from "../../notifications/notification.types";
import type { DbOrTx } from "../../../common/rbac/access-mutation-commit";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { AblyService } from "../../realtime/ably.service";
import { OrgMembershipAccessRevocation } from "./org-membership-access-revocation";
import {
  queryOwnedModuleKeys,
  queryPrivilegedRoleNames,
  querySoleAdminSpaceNames,
} from "./org-member-authority-queries";
import { PG_FOREIGN_KEY_VIOLATION, PG_NOT_NULL_VIOLATION, PG_RESTRICT_VIOLATION, getPostgresErrorDetails } from "../../../common/db/postgres-error";

/**
 * A 23502 raised while deleting a membership is an ON DELETE SET NULL writing
 * NULL into a non-nullable column: the referential action is unreachable and the
 * delete can never succeed until the constraint changes. Left unclassified it
 * escapes as a 500, which is how this failed silently before 0992.
 */
export function departureBlockMessage(err: unknown): string | null {
  const { code, constraint, table, column } = getPostgresErrorDetails(err);
  if (code === PG_FOREIGN_KEY_VIOLATION || code === PG_RESTRICT_VIOLATION) {
    return `a related record still references the membership (constraint: ${constraint ?? "unknown"})`;
  }
  if (code === PG_NOT_NULL_VIOLATION) {
    const where = table && column ? `${table}.${column}` : (table ?? "an unknown table");
    return `a related record requires the membership and cannot release it (${where})`;
  }
  return null;
}

@Injectable()
export class OrgMemberDepartureService {
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

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    try {
      await withMembershipMutations(this.cache, (mutations) =>
        runInTenantTransaction(
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

            const soleAdminSpaces = await querySoleAdminSpaceNames(tx, orgId, member.id);
            if (soleAdminSpaces.length > 0) {
              throw new BadRequestException(
                `Assign another knowledge space admin before removing this member. Sole admin of: ${soleAdminSpaces.join(", ")}.`,
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
              .delete(orgUnitMembers)
              .where(
                and(
                  eq(orgUnitMembers.membershipId, member.id),
                  eq(orgUnitMembers.orgId, orgId),
                ),
              );

            const revocation = await this.accessRevocation.planOrgScopedRevocation(
              tx,
              orgId,
              memberUserId,
              "removed",
            );
            await mutations.deleteMembership(
              tx,
              { orgId, userId: memberUserId },
              {
                audit: {
                  action: "org.member_removed",
                  userId: actorUserId,
                  targetId: memberUserId,
                  targetType: "user",
                },
                revoke: { cache: this.cache, loses: revocation.loses },
                afterCommit: () =>
                  Promise.all([
                    revocation.afterCommit(),
                    this.accessRevocation.notifyAccessLoss(orgId, memberUserId, "removed"),
                    this.invalidateMemberListCaches(orgId),
                  ]).then(() => undefined),
              },
            );
          },
          { orgId },
        ),
      );
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      )
        throw err;
      const reason = departureBlockMessage(err);
      if (reason) {
        throw new BadRequestException(
          `Cannot remove this member: ${reason}. Resolve the dependency and retry.`,
        );
      }
      throw err;
    }

    await this.db
      .delete(accountOrganizationIndex)
      .where(
        and(
          eq(accountOrganizationIndex.userId, memberUserId),
          eq(accountOrganizationIndex.orgId, orgId),
        ),
      );

    return { success: true };
  }

  private invalidateMemberListCaches(orgId: string): Promise<void> {
    return Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
      this.cache.invalidateForOrg(orgId, "rbac:members"),
      this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      this.cache.invalidateForOrg(orgId, "users:stats"),
    ]).then(() => undefined);
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
      const nextOrgId = await withMembershipMutations(this.cache, (mutations) =>
        runInTenantTransaction(
          this.db,
          async (tx) => {
            const ownedModuleKeys = await queryOwnedModuleKeys(tx, orgId, membership.id);
            if (ownedModuleKeys.length > 0) {
              throw new BadRequestException(
                `Transfer module ownership before leaving this organization. Owned modules: ${ownedModuleKeys.join(", ")}.`,
              );
            }

            const soleAdminSpaces = await querySoleAdminSpaceNames(tx, orgId, membership.id);
            if (soleAdminSpaces.length > 0) {
              throw new BadRequestException(
                `Assign another knowledge space admin before leaving this organization. Sole admin of: ${soleAdminSpaces.join(", ")}.`,
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
              .delete(orgUnitMembers)
              .where(
                and(
                  eq(orgUnitMembers.membershipId, membership.id),
                  eq(orgUnitMembers.orgId, orgId),
                ),
              );

            const revocation = await this.accessRevocation.planOrgScopedRevocation(
              tx,
              orgId,
              userId,
              "left",
            );
            const departed = await this.memberLeftEvents(tx, orgId, userId);
            await mutations.deleteMembership(
              tx,
              { orgId, userId },
              {
                audit: {
                  action: "org.member_left",
                  userId,
                  targetId: userId,
                  targetType: "user",
                },
                revoke: { cache: this.cache, loses: revocation.loses },
                notify: { via: this.dispatch, events: departed },
                afterCommit: () =>
                  Promise.all([
                    revocation.afterCommit(),
                    this.cache.invalidateNamespaceForOrg(orgId, "org:profile"),
                    this.invalidateMemberListCaches(orgId),
                  ]).then(() => undefined),
              },
            );

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
        ),
      );

      await this.db
        .delete(accountOrganizationIndex)
        .where(
          and(
            eq(accountOrganizationIndex.userId, userId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        );

      return { success: true, nextOrgId };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const reason = departureBlockMessage(err);
      if (reason) {
        throw new BadRequestException(
          `Cannot leave this organization: ${reason}. Resolve the dependency and retry.`,
        );
      }
      throw err;
    }
  }

  private async memberLeftEvents(
    tx: DbOrTx,
    orgId: string,
    userId: string,
  ): Promise<DispatchEventInput[]> {
    const [adminIds, member] = await Promise.all([
      getOrgAdminUserIds(this.db, orgId),
      tx.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true, name: true },
      }),
    ]);
    const admins = adminIds.filter((adminId) => adminId !== userId);
    if (admins.length === 0) return [];

    return [{
      eventKey: "organization.member.left",
      orgId,
      actorUserId: userId,
      targetUserIds: admins,
      entityType: "user",
      entityId: userId,
      title: "A member left the organization",
      message: `${member?.name ?? member?.email ?? "A member"} left the organization. Their seat is now free.`,
      link: "/users",
    }];
  }
}
