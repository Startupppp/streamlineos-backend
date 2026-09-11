import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  userDelegationPermissions,
  userDelegations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateDelegationInput,
  ListDelegationsQuery,
} from "./dto/delegation.schemas";
import {
  assertDelegationPolicy,
  assertDelegationTarget,
} from "./delegation-policy";
import {
  delegateeMember,
  delegationSelection,
  delegatorMember,
  joinDelegateeMember,
  joinDelegatorMember,
  listDelegationsPage,
  type DelegationListingDeps,
} from "./lib/delegation-listing";

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private get listingDeps(): DelegationListingDeps {
    return { db: this.db };
  }

  private async invalidateDelegateeSession(userId: string): Promise<void> {
    const invalidate = () => this.cache.invalidate(CACHE_KEYS.userSession(userId));
    await invalidate();
    registerAfterCommit(invalidate);
  }

  async list(
    orgId: string,
    userId: string,
    query: ListDelegationsQuery = { limit: 20 },
  ) {
    return listDelegationsPage(this.listingDeps, orgId, userId, "received", query);
  }

  async listGiven(
    orgId: string,
    delegatorId: string,
    query: ListDelegationsQuery = { limit: 20 },
  ) {
    return listDelegationsPage(this.listingDeps, orgId, delegatorId, "given", query);
  }

  async create(actor: CurrentUserContext, body: CreateDelegationInput) {
    assertDelegationTarget(actor.userId, body.delegateeId);
    const now = new Date();
    const startsAt = body.startsAt ? new Date(body.startsAt) : now;
    const endsAt = new Date(body.endsAt);
    const record = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const resolved = await this.access.resolveUserPermissions(
          actor.orgId,
          actor.userId,
        );
        assertDelegationPolicy(
          actor,
          resolved,
          body.permissions,
          startsAt,
          endsAt,
          now,
        );
        const [delegator, delegatee] = await Promise.all([
          tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, actor.orgId),
              eq(organizationMembers.userId, actor.userId),
              eq(organizationMembers.status, "ACTIVE"),
            ),
            columns: { id: true },
          }),
          tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, actor.orgId),
              eq(organizationMembers.userId, body.delegateeId),
              eq(organizationMembers.status, "ACTIVE"),
            ),
            columns: { id: true },
          }),
        ]);
        if (!delegator) {
          throw new NotFoundException("Active delegator membership not found");
        }
        if (!delegatee) {
          throw new NotFoundException("Active delegatee not found");
        }
        const [created] = await tx
          .insert(userDelegations)
          .values({
            id: randomUUID(),
            orgId: actor.orgId,
            delegatorMembershipId: delegator.id,
            delegateeMembershipId: delegatee.id,
            startsAt,
            endsAt,
            reason: body.reason ?? null,
            status: "ACTIVE",
          })
          .returning();
        if (!created) throw new Error("Failed to create delegation");
        await tx.insert(userDelegationPermissions).values(
          body.permissions.map((permissionKey) => ({
            orgId: actor.orgId,
            delegationId: created.id,
            permissionKey,
          })),
        );
        await bumpPermissionsVersion(tx, actor.orgId);
        await this.audit.logCritical({
          action: "delegation.created",
          userId: actor.userId,
          orgId: actor.orgId,
          targetId: created.id,
          targetType: "user_delegation",
          metadata: {
            delegatorId: actor.userId,
            delegateeId: body.delegateeId,
            permissions: body.permissions,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            reason: body.reason ?? null,
          },
        });
        return {
          ...created,
          delegatorId: actor.userId,
          delegateeId: body.delegateeId,
          permissions: body.permissions,
        };
      },
      { orgId: actor.orgId },
    );
    await this.invalidateDelegateeSession(body.delegateeId);
    return record;
  }

  async revoke(orgId: string, id: string, actor: CurrentUserContext) {
    const result = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [delegation] = await tx
          .select(delegationSelection)
          .from(userDelegations)
          .innerJoin(delegatorMember, joinDelegatorMember)
          .innerJoin(delegateeMember, joinDelegateeMember)
          .where(
            and(
              eq(userDelegations.id, id),
              eq(userDelegations.orgId, orgId),
            ),
          );
        if (!delegation) {
          throw new NotFoundException("Delegation not found");
        }
        const actorMemberId = actingMembershipId(actor.principal);
        if (!actor.isOrgOwner && delegation.delegatorMembershipId !== actorMemberId) {
          throw new ForbiddenException(
            "Only the delegator or an org owner can revoke a delegation",
          );
        }
        const [permissionRows, membershipRows] = await Promise.all([
          tx
            .select({ permissionKey: userDelegationPermissions.permissionKey })
            .from(userDelegationPermissions)
            .where(
              and(
                eq(userDelegationPermissions.orgId, orgId),
                eq(userDelegationPermissions.delegationId, id),
              ),
            )
            .orderBy(asc(userDelegationPermissions.permissionKey)),
          tx
            .select({
              id: organizationMembers.id,
              userId: organizationMembers.userId,
            })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.id, [
                  delegation.delegatorMembershipId,
                  delegation.delegateeMembershipId,
                ]),
              ),
            ),
        ]);
        const membershipUserMap = new Map(membershipRows.map((r) => [r.id, r.userId]));
        const delegatorUserId = membershipUserMap.get(delegation.delegatorMembershipId) ?? null;
        const delegateeUserId = membershipUserMap.get(delegation.delegateeMembershipId) ?? null;
        const [updated] = await tx
          .update(userDelegations)
          .set({
            status: "REVOKED",
            revokedAt: new Date(),
            revokedBy: actor.userId,
          })
          .where(
            and(
              eq(userDelegations.id, id),
              eq(userDelegations.orgId, orgId),
            ),
          )
          .returning();
        await bumpPermissionsVersion(tx, orgId);
        await this.audit.logCritical({
          action: "delegation.revoked",
          userId: actor.userId,
          orgId,
          targetId: id,
          targetType: "user_delegation",
          metadata: {
            delegatorId: delegatorUserId,
            delegateeId: delegateeUserId,
            permissions: permissionRows.map((row) => row.permissionKey),
          },
        });
        return {
          updated: {
            ...updated,
            delegatorId: delegation.delegatorId,
            delegateeId: delegation.delegateeId,
            permissions: permissionRows.map((row) => row.permissionKey),
          },
          delegateeUserId,
        };
      },
      { orgId },
    );
    if (result.delegateeUserId) {
      await this.invalidateDelegateeSession(result.delegateeUserId);
    }
    const { updated } = result;
    return updated;
  }
}
