import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  organizations,
  ownershipTransfers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { stableHash } from "../../common/cache/cache-hash";
import { bumpPermissionsVersion, type DbOrTx } from "../../common/rbac/access-invalidate";
import { assignModuleOwnerRole, revokeModuleOwnerRole } from "./module-owner-role.helper";
import { bustMembershipStatusCache } from "../../common/auth/jwt-auth.guard";
import type {
  DeclineTransferInput,
  InitiateModuleTransferInput,
  InitiateOrgTransferInput,
  ListTransfersInput,
  SetModuleOwnerInput,
} from "./dto/ownership.schemas";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";

@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  private async invalidateUserAccess(orgId: string, userId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    bustMembershipStatusCache(userId, orgId);
  }

  private async fetchMembershipByUser(
    db: DbOrTx,
    orgId: string,
    userId: string,
  ) {
    const [row] = await db
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
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async fetchMembershipById(
    db: DbOrTx,
    orgId: string,
    membershipId: number,
  ) {
    const [row] = await db
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
          eq(organizationMembers.id, membershipId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listModuleOwnerships(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.moduleOwnershipsList(orgId),
      () => this.fetchModuleOwnerships(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchModuleOwnerships(orgId: string) {
    return this.db
      .select({
        moduleKey: moduleOwnerships.moduleKey,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerUserId: organizationMembers.userId,
        ownerName: users.name,
        ownerEmail: users.email,
        createdAt: moduleOwnerships.createdAt,
        updatedAt: moduleOwnerships.updatedAt,
      })
      .from(moduleOwnerships)
      .innerJoin(
        organizationMembers,
        and(
          eq(moduleOwnerships.orgId, organizationMembers.orgId),
          eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(moduleOwnerships.orgId, orgId))
      .orderBy(moduleOwnerships.moduleKey);
  }

  async getModuleOwnership(orgId: string, moduleKey: string) {
    return this.cache.cached(
      CACHE_KEYS.moduleOwnershipDetail(orgId, moduleKey),
      () => this.fetchModuleOwnership(orgId, moduleKey),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchModuleOwnership(orgId: string, moduleKey: string) {
    const [row] = await this.db
      .select({
        moduleKey: moduleOwnerships.moduleKey,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerUserId: organizationMembers.userId,
        ownerName: users.name,
        ownerEmail: users.email,
        createdAt: moduleOwnerships.createdAt,
        updatedAt: moduleOwnerships.updatedAt,
      })
      .from(moduleOwnerships)
      .innerJoin(
        organizationMembers,
        and(
          eq(moduleOwnerships.orgId, organizationMembers.orgId),
          eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.moduleKey, moduleKey),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Module ownership not found");
    return row;
  }

  async forceSetModuleOwner(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: SetModuleOwnerInput,
  ) {
    const target = await this.fetchMembershipById(this.db, orgId, input.ownerMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive module ownership");
    }

    await this.db.transaction(async (tx) => {
      const [prevOwnership] = await tx
        .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .limit(1);

      await tx
        .insert(moduleOwnerships)
        .values({
          orgId,
          moduleKey,
          ownerMembershipId: input.ownerMembershipId,
        })
        .onConflictDoUpdate({
          target: [moduleOwnerships.orgId, moduleOwnerships.moduleKey],
          set: {
            ownerMembershipId: input.ownerMembershipId,
            updatedAt: new Date(),
          },
        });

      await tx
        .update(ownershipTransfers)
        .set({ status: "CANCELLED" })
        .where(
          and(
            eq(ownershipTransfers.orgId, orgId),
            eq(ownershipTransfers.moduleKey, moduleKey),
            eq(ownershipTransfers.scope, "MODULE"),
            eq(ownershipTransfers.status, "PENDING"),
          ),
        );

      if (
        prevOwnership !== undefined &&
        prevOwnership.ownerMembershipId !== input.ownerMembershipId
      ) {
        await revokeModuleOwnerRole(tx, orgId, moduleKey, prevOwnership.ownerMembershipId);
      }
      await assignModuleOwnerRole(tx, orgId, moduleKey, input.ownerMembershipId);

      await bumpPermissionsVersion(tx, orgId);
    });

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipsList(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleOwnershipDetail(orgId, moduleKey)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
      this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(orgId)),
    ]);

    this.audit.log({
      action: "ownership.module_owner_forced",
      userId: actorUserId,
      orgId,
      targetId: String(input.ownerMembershipId),
      targetType: "membership",
      metadata: { moduleKey, ownerMembershipId: input.ownerMembershipId },
    });

    return { success: true as const };
  }

  async initiateOrgTransfer(
    orgId: string,
    actorUserId: string,
    input: InitiateOrgTransferInput,
  ) {
    const actorMembership = await this.fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");
    if (!actorMembership.isOwner) throw new ForbiddenException("Only the org owner can initiate an org ownership transfer");

    if (actorMembership.id === input.toMembershipId) {
      throw new BadRequestException("Cannot transfer ownership to yourself");
    }

    const target = await this.fetchMembershipById(this.db, orgId, input.toMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive ownership");
    }

    const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

    try {
      const [transfer] = await this.db
        .insert(ownershipTransfers)
        .values({
          orgId,
          scope: "ORGANIZATION",
          moduleKey: null,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          status: "PENDING",
          expiresAt,
          reason: input.reason ?? null,
        })
        .returning({ id: ownershipTransfers.id, expiresAt: ownershipTransfers.expiresAt });

      if (!transfer) throw new Error("Insert returned no rows");

      this.audit.log({
        action: "ownership.org_transfer_initiated",
        userId: actorUserId,
        orgId,
        targetId: String(input.toMembershipId),
        targetType: "membership",
        metadata: {
          transferId: transfer.id,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          expiresAt,
        },
      });

      await Promise.all([
        this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
        this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(orgId)),
      ]);

      return { transferId: transfer.id, expiresAt: transfer.expiresAt };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException("A pending org ownership transfer already exists");
      }
      throw err;
    }
  }

  async initiateModuleTransfer(
    orgId: string,
    actorUserId: string,
    moduleKey: string,
    input: InitiateModuleTransferInput,
    isOrgOwner: boolean,
  ) {
    const actorMembership = await this.fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");

    if (!isOrgOwner) {
      const [currentOwnership] = await this.db
        .select({ ownerMembershipId: moduleOwnerships.ownerMembershipId })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .limit(1);
      if (!currentOwnership) {
        throw new NotFoundException("Module ownership record not found");
      }
      if (currentOwnership.ownerMembershipId !== actorMembership.id) {
        throw new ForbiddenException("Only the current module owner or an org owner may initiate a module ownership transfer");
      }
    }

    if (actorMembership.id === input.toMembershipId) {
      throw new BadRequestException("Cannot transfer module ownership to yourself");
    }

    const target = await this.fetchMembershipById(this.db, orgId, input.toMembershipId);
    if (!target) throw new NotFoundException("Target membership not found in this organization");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Target membership must be ACTIVE to receive module ownership");
    }

    const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

    try {
      const [transfer] = await this.db
        .insert(ownershipTransfers)
        .values({
          orgId,
          scope: "MODULE",
          moduleKey,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          status: "PENDING",
          expiresAt,
          reason: input.reason ?? null,
        })
        .returning({ id: ownershipTransfers.id, expiresAt: ownershipTransfers.expiresAt });

      if (!transfer) throw new Error("Insert returned no rows");

      this.audit.log({
        action: "ownership.module_transfer_initiated",
        userId: actorUserId,
        orgId,
        targetId: String(input.toMembershipId),
        targetType: "membership",
        metadata: {
          transferId: transfer.id,
          moduleKey,
          fromMembershipId: actorMembership.id,
          toMembershipId: input.toMembershipId,
          expiresAt,
        },
      });

      await Promise.all([
        this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKey)),
        this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
        this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(orgId)),
      ]);

      return { transferId: transfer.id, expiresAt: transfer.expiresAt };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException(`A pending transfer for module "${moduleKey}" already exists`);
      }
      throw err;
    }
  }

  async acceptTransfer(orgId: string, actorUserId: string, transferId: string) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        expiresAt: ownershipTransfers.expiresAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(`Transfer is already ${transfer.status.toLowerCase()}`);
    }
    if (transfer.expiresAt < new Date()) {
      await this.db
        .update(ownershipTransfers)
        .set({ status: "EXPIRED" })
        .where(eq(ownershipTransfers.id, transferId));
      throw new BadRequestException("Transfer has expired");
    }

    const recipientMembership = await this.fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!recipientMembership) throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException("Only the designated recipient may accept this transfer");
    }
    if (recipientMembership.status !== "ACTIVE") {
      throw new BadRequestException("Your membership must be ACTIVE to accept a transfer");
    }

    let fromUserId: string;

    if (transfer.scope === "ORGANIZATION") {
      fromUserId = await this.db.transaction(async (tx) => {
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
                eq(organizationMembers.id, transfer.fromMembershipId),
                eq(organizationMembers.id, transfer.toMembershipId),
              ),
            ),
          )
          .for("update");

        const fromMember = memberships.find((m) => m.id === transfer.fromMembershipId);
        const toMember = memberships.find((m) => m.id === transfer.toMembershipId);

        if (!fromMember) throw new BadRequestException("Initiating member no longer exists");
        const isCurrentOwner =
          fromMember.isOwner ||
          (org.ownerMembershipId != null && org.ownerMembershipId === fromMember.id);
        if (!isCurrentOwner) {
          throw new BadRequestException("Initiator is no longer the organization owner; transfer is invalid");
        }
        if (!toMember || toMember.status !== "ACTIVE") {
          throw new BadRequestException("Recipient membership is no longer active");
        }

        await tx
          .update(organizationMembers)
          .set({ isOwner: false, role: ORG_MEMBER_ROLES.ORG_ADMIN })
          .where(eq(organizationMembers.id, fromMember.id));
        await syncStructuralRoleAssignment(
          tx,
          orgId,
          fromMember.id,
          ORG_MEMBER_ROLES.ORG_ADMIN,
        );
        await tx
          .update(organizationMembers)
          .set({ isOwner: true, role: "OWNER", status: "ACTIVE" })
          .where(eq(organizationMembers.id, toMember.id));
        await tx
          .update(organizations)
          .set({ ownerMembershipId: toMember.id })
          .where(eq(organizations.id, orgId));

        await tx
          .update(ownershipTransfers)
          .set({ status: "ACCEPTED", respondedAt: new Date() })
          .where(eq(ownershipTransfers.id, transferId));

        await bumpPermissionsVersion(tx, orgId);
        return fromMember.userId;
      });
    } else {
      const { moduleKey } = transfer;
      if (!moduleKey) throw new BadRequestException("Invalid transfer: missing module key");

      fromUserId = await this.db.transaction(async (tx) => {
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
                eq(organizationMembers.id, transfer.fromMembershipId),
                eq(organizationMembers.id, transfer.toMembershipId),
              ),
            ),
          )
          .for("update");

        const fromMember = memberships.find((m) => m.id === transfer.fromMembershipId);
        const toMember = memberships.find((m) => m.id === transfer.toMembershipId);

        if (!fromMember) throw new BadRequestException("Initiating member no longer exists");
        if (currentOwnership && currentOwnership.ownerMembershipId !== fromMember.id) {
          throw new BadRequestException("Initiator is no longer the module owner; transfer is invalid");
        }
        if (!toMember || toMember.status !== "ACTIVE") {
          throw new BadRequestException("Recipient membership is no longer active");
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
        await assignModuleOwnerRole(tx, orgId, moduleKey, toMember.id);

        await tx
          .update(ownershipTransfers)
          .set({ status: "ACCEPTED", respondedAt: new Date() })
          .where(eq(ownershipTransfers.id, transferId));

        await bumpPermissionsVersion(tx, orgId);
        return fromMember.userId;
      });
    }

    await this.invalidateUserAccess(orgId, actorUserId);
    await this.invalidateUserAccess(orgId, fromUserId);

    const moduleKeyForAccept = transfer.scope === "MODULE" ? transfer.moduleKey : null;
    await Promise.all([
      ...(moduleKeyForAccept
        ? [
            this.cache.invalidate(CACHE_KEYS.moduleOwnershipsList(orgId)),
            this.cache.invalidate(CACHE_KEYS.moduleOwnershipDetail(orgId, moduleKeyForAccept)),
            this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKeyForAccept)),
          ]
        : []),
      this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(orgId)),
    ]);

    this.audit.log({
      action: "ownership.transfer_accepted",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
      },
    });

    return { success: true as const };
  }

  async declineTransfer(
    orgId: string,
    actorUserId: string,
    transferId: string,
    input: DeclineTransferInput,
  ) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(`Transfer is already ${transfer.status.toLowerCase()}`);
    }

    const recipientMembership = await this.fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!recipientMembership) throw new ForbiddenException("Not a member of this organization");
    if (recipientMembership.id !== transfer.toMembershipId) {
      throw new ForbiddenException("Only the designated recipient may decline this transfer");
    }

    await this.db
      .update(ownershipTransfers)
      .set({ status: "DECLINED", respondedAt: new Date(), reason: input.reason ?? null })
      .where(eq(ownershipTransfers.id, transferId));

    const moduleKeyForDecline = transfer.scope === "MODULE" ? transfer.moduleKey : null;
    await Promise.all([
      ...(moduleKeyForDecline
        ? [this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKeyForDecline))]
        : []),
      this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
      this.cache.invalidate(CACHE_KEYS.incomingTransfers(orgId, actorUserId)),
    ]);

    this.audit.log({
      action: "ownership.transfer_declined",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
        reason: input.reason,
      },
    });

    return { success: true as const };
  }

  async cancelTransfer(
    orgId: string,
    actorUserId: string,
    transferId: string,
    isOrgOwner: boolean,
  ) {
    const [transfer] = await this.db
      .select({
        id: ownershipTransfers.id,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        status: ownershipTransfers.status,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        toMembershipId: ownershipTransfers.toMembershipId,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.id, transferId),
          eq(ownershipTransfers.orgId, orgId),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING") {
      throw new BadRequestException(`Transfer is already ${transfer.status.toLowerCase()}`);
    }

    const actorMembership = await this.fetchMembershipByUser(this.db, orgId, actorUserId);
    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");

    if (!isOrgOwner && actorMembership.id !== transfer.fromMembershipId) {
      throw new ForbiddenException("Only the initiator or an org owner may cancel this transfer");
    }

    await this.db
      .update(ownershipTransfers)
      .set({ status: "CANCELLED" })
      .where(eq(ownershipTransfers.id, transferId));

    const moduleKeyForCancel = transfer.scope === "MODULE" ? transfer.moduleKey : null;
    await Promise.all([
      ...(moduleKeyForCancel
        ? [this.cache.invalidate(CACHE_KEYS.moduleAccessOwnership(orgId, moduleKeyForCancel))]
        : []),
      this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(orgId)),
    ]);

    this.audit.log({
      action: "ownership.transfer_cancelled",
      userId: actorUserId,
      orgId,
      targetId: transferId,
      targetType: "ownership_transfer",
      metadata: {
        transferId,
        scope: transfer.scope,
        moduleKey: transfer.moduleKey ?? undefined,
        fromMembershipId: transfer.fromMembershipId,
        toMembershipId: transfer.toMembershipId,
      },
    });

    return { success: true as const };
  }

  async listTransfers(orgId: string, filters: ListTransfersInput) {
    const hash = stableHash({
      page: filters.page,
      limit: filters.limit,
      scope: filters.scope ?? null,
      status: filters.status ?? null,
    });
    return this.cache.cached(
      CACHE_KEYS.ownershipTransfersList(orgId, hash),
      () => this.fetchTransfers(orgId, filters),
      60,
    );
  }

  private async fetchTransfers(orgId: string, filters: ListTransfersInput) {
    const offset = (filters.page - 1) * filters.limit;

    const conditions = [eq(ownershipTransfers.orgId, orgId)];
    if (filters.scope) conditions.push(eq(ownershipTransfers.scope, filters.scope));
    if (filters.status) conditions.push(eq(ownershipTransfers.status, filters.status));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: ownershipTransfers.id,
          scope: ownershipTransfers.scope,
          moduleKey: ownershipTransfers.moduleKey,
          fromMembershipId: ownershipTransfers.fromMembershipId,
          toMembershipId: ownershipTransfers.toMembershipId,
          status: ownershipTransfers.status,
          initiatedAt: ownershipTransfers.initiatedAt,
          respondedAt: ownershipTransfers.respondedAt,
          expiresAt: ownershipTransfers.expiresAt,
          reason: ownershipTransfers.reason,
        })
        .from(ownershipTransfers)
        .where(and(...conditions))
        .orderBy(desc(ownershipTransfers.initiatedAt))
        .limit(filters.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(ownershipTransfers)
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: rows,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  async listIncomingTransfers(orgId: string, userId: string) {
    return this.cache.cached(
      CACHE_KEYS.incomingTransfers(orgId, userId),
      () => this.fetchIncomingTransfers(orgId, userId),
      60,
    );
  }

  private async fetchIncomingTransfers(orgId: string, userId: string) {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (!membership) return { data: [] };

    const rows = await this.db
      .select({
        id: ownershipTransfers.id,
        scope: ownershipTransfers.scope,
        moduleKey: ownershipTransfers.moduleKey,
        fromMembershipId: ownershipTransfers.fromMembershipId,
        toMembershipId: ownershipTransfers.toMembershipId,
        status: ownershipTransfers.status,
        initiatedAt: ownershipTransfers.initiatedAt,
        expiresAt: ownershipTransfers.expiresAt,
        reason: ownershipTransfers.reason,
        fromName: users.name,
        fromEmail: users.email,
      })
      .from(ownershipTransfers)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, ownershipTransfers.fromMembershipId),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(ownershipTransfers.orgId, orgId),
          eq(ownershipTransfers.toMembershipId, membership.id),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .orderBy(desc(ownershipTransfers.initiatedAt))
      .limit(20);

    return { data: rows };
  }


  async expireStaleTransfers(orgId?: string): Promise<{ expired: number }> {
    const conditions = [
      eq(ownershipTransfers.status, "PENDING"),
      lt(ownershipTransfers.expiresAt, new Date()),
    ];
    if (orgId) conditions.push(eq(ownershipTransfers.orgId, orgId));

    const rows = await this.db
      .update(ownershipTransfers)
      .set({ status: "EXPIRED" })
      .where(and(...conditions))
      .returning({ id: ownershipTransfers.id, orgId: ownershipTransfers.orgId });

    const affectedOrgIds = [...new Set(rows.map((r) => r.orgId))];
    await Promise.all(
      affectedOrgIds.flatMap((affectedOrgId) => [
        this.cache.invalidatePattern(CACHE_KEYS.ownershipTransfersPattern(affectedOrgId)),
        this.cache.invalidatePattern(CACHE_KEYS.incomingTransfersPattern(affectedOrgId)),
      ]),
    );

    return { expired: rows.length };
  }
}
