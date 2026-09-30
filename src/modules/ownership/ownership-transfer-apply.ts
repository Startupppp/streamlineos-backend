import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  organizations,
  ownershipTransfers,
} from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import { withMembershipMutations } from "../../common/org/membership-mutations";
import type { CacheService } from "../../common/cache/cache.service";
import {
  assertModuleOwnerRoleAssigned,
  revokeModuleOwnerRole,
} from "./module-owner-role.helper";

export async function applyOrgTransfer(
  db: Db,
  cache: CacheService,
  orgId: string,
  transferId: string,
  fromMembershipId: number,
  toMembershipId: number,
): Promise<string> {
  return withMembershipMutations(cache, (membership) =>
    db.transaction(async (tx) => {
      const [org] = await tx
        .select({ ownerMembershipId: organizations.ownerMembershipId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");

      const memberships = await tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          isOwner: organizationMembers.isOwner,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            or(
              eq(organizationMembers.id, fromMembershipId),
              eq(organizationMembers.id, toMembershipId),
            ),
          ),
        )
        .for("update");

      const fromMember = memberships.find((m) => m.id === fromMembershipId);
      const toMember = memberships.find((m) => m.id === toMembershipId);

      if (!fromMember)
        throw new BadRequestException("Initiating member no longer exists");
      const isCurrentOwner =
        fromMember.isOwner ||
        (org.ownerMembershipId != null &&
          org.ownerMembershipId === fromMember.id);
      if (!isCurrentOwner) {
        throw new BadRequestException(
          "Organization ownership changed since this transfer was initiated; it can no longer be accepted",
        );
      }
      if (!toMember || toMember.status !== "ACTIVE") {
        throw new BadRequestException(
          "Recipient membership is no longer active",
        );
      }

      await membership.transferOrgOwnership(tx, {
        orgId,
        from: { membershipId: fromMember.id, userId: fromMember.userId },
        to: { membershipId: toMember.id, userId: toMember.userId },
        demotedRole: ORG_MEMBER_ROLES.ORG_ADMIN,
        ownerRole: "OWNER",
      });
      await tx
        .update(organizations)
        .set({ ownerMembershipId: toMember.id })
        .where(eq(organizations.id, orgId));

      const [accepted] = await tx
        .update(ownershipTransfers)
        .set({ status: "ACCEPTED", respondedAt: new Date() })
        .where(
          and(
            eq(ownershipTransfers.id, transferId),
            eq(ownershipTransfers.orgId, orgId),
            eq(ownershipTransfers.status, "PENDING"),
          ),
        )
        .returning({ id: ownershipTransfers.id });
      if (!accepted)
        throw new ConflictException(
          "Transfer is no longer pending; a concurrent response committed first",
        );

      await commitAccessChange(tx, orgId);
      return fromMember.userId;
    }),
  );
}

export async function applyModuleTransfer(
  db: Db,
  orgId: string,
  transferId: string,
  moduleKey: string | null,
  fromMembershipId: number,
  toMembershipId: number,
): Promise<string> {
  if (!moduleKey)
    throw new BadRequestException("Invalid transfer: missing module key");

  return db.transaction(async (tx) => {
    const [currentOwnership] = await tx
      .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
      .from(moduleOwnerships)
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.moduleKey, moduleKey),
        ),
      )
      .for("update");

    if (!currentOwnership || currentOwnership.ownerMembershipId !== fromMembershipId) {
      throw new BadRequestException(
        "Module ownership changed since this transfer was initiated; it can no longer be accepted",
      );
    }

    const memberships = await tx
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        status: organizationMembers.status,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          or(
            eq(organizationMembers.id, fromMembershipId),
            eq(organizationMembers.id, toMembershipId),
          ),
        ),
      )
      .for("update");

    const fromMember = memberships.find((m) => m.id === fromMembershipId);
    const toMember = memberships.find((m) => m.id === toMembershipId);

    if (!fromMember)
      throw new BadRequestException("Expected current owner's membership no longer exists");
    if (!toMember || toMember.status !== "ACTIVE") {
      throw new BadRequestException(
        "Recipient membership is no longer active",
      );
    }

    await tx
      .insert(moduleOwnerships)
      .values({
        orgId,
        moduleKey,
        ownerMembershipId: toMember.id,
      })
      .onConflictDoUpdate({
        target: [moduleOwnerships.orgId, moduleOwnerships.moduleKey],
        set: {
          ownerMembershipId: toMember.id,
          updatedAt: new Date(),
        },
      });

    await revokeModuleOwnerRole(tx, orgId, moduleKey, fromMember.id);
    await assertModuleOwnerRoleAssigned(tx, orgId, moduleKey, toMember.id);

    const [accepted] = await tx
      .update(ownershipTransfers)
      .set({ status: "ACCEPTED", respondedAt: new Date() })
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .returning({ id: ownershipTransfers.id });
    if (!accepted)
      throw new ConflictException(
        "Transfer is no longer pending; a concurrent response committed first",
      );

    await commitAccessChange(tx, orgId);
    return fromMember.userId;
  });
}
