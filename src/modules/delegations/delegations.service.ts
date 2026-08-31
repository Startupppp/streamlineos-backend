import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  userDelegationPermissions,
  userDelegations,
  users,
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

/**
 * Storage keys a delegation on the two memberships; the API has always spoken
 * user ids, and callers, audit metadata and the frontend all still do. The two
 * joins below are the whole translation, so the shape crossing this service's
 * boundary is unchanged by the move.
 */
const delegatorMember = alias(organizationMembers, "delegator_member");
const delegateeMember = alias(organizationMembers, "delegatee_member");

const delegationSelection = {
  id: userDelegations.id,
  orgId: userDelegations.orgId,
  delegatorMembershipId: userDelegations.delegatorMembershipId,
  delegateeMembershipId: userDelegations.delegateeMembershipId,
  delegatorId: delegatorMember.userId,
  delegateeId: delegateeMember.userId,
  startsAt: userDelegations.startsAt,
  endsAt: userDelegations.endsAt,
  reason: userDelegations.reason,
  status: userDelegations.status,
  createdAt: userDelegations.createdAt,
  revokedAt: userDelegations.revokedAt,
  revokedBy: userDelegations.revokedBy,
} as const;

const joinDelegatorMember = and(
  eq(delegatorMember.orgId, userDelegations.orgId),
  eq(delegatorMember.id, userDelegations.delegatorMembershipId),
);
const joinDelegateeMember = and(
  eq(delegateeMember.orgId, userDelegations.orgId),
  eq(delegateeMember.id, userDelegations.delegateeMembershipId),
);

type DelegationRow = typeof userDelegations.$inferSelect & {
  delegatorId: string;
  delegateeId: string;
};
type DelegationDirection = "received" | "given";
type DelegationLifecycle = "ACTIVE" | "SCHEDULED" | "EXPIRED" | "REVOKED";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function resolveLifecycle(
  row: DelegationRow,
  now: Date,
): DelegationLifecycle {
  if (row.status !== "ACTIVE") return "REVOKED";
  if (row.startsAt > now) return "SCHEDULED";
  if (row.endsAt <= now) return "EXPIRED";
  return "ACTIVE";
}

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async invalidateDelegateeSession(userId: string): Promise<void> {
    const invalidate = () => this.cache.invalidate(CACHE_KEYS.userSession(userId));
    await invalidate();
    registerAfterCommit(invalidate);
  }

  private async withPermissions(
    rows: DelegationRow[],
    now: Date,
  ) {
    if (rows.length === 0) return [];
    const participantMembershipIds = Array.from(
      new Set(rows.flatMap((row) => [row.delegatorMembershipId, row.delegateeMembershipId])),
    );
    const [permissionRows, participantRows] = await Promise.all([
      this.db
        .select({
          delegationId: userDelegationPermissions.delegationId,
          permissionKey: userDelegationPermissions.permissionKey,
        })
        .from(userDelegationPermissions)
        .where(
          and(
            eq(userDelegationPermissions.orgId, rows[0]!.orgId),
            inArray(
              userDelegationPermissions.delegationId,
              rows.map((row) => row.id),
            ),
          ),
        )
        .orderBy(
          asc(userDelegationPermissions.delegationId),
          asc(userDelegationPermissions.permissionKey),
        ),
      this.db
        .select({
          membershipId: organizationMembers.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, rows[0]!.orgId),
            inArray(organizationMembers.id, participantMembershipIds),
          ),
        ),
    ]);
    const byDelegation = new Map<string, string[]>();
    for (const row of permissionRows) {
      const values = byDelegation.get(row.delegationId) ?? [];
      values.push(row.permissionKey);
      byDelegation.set(row.delegationId, values);
    }
    const nameByMembershipId = new Map(
      participantRows.map((member) => {
        const structuredName = [member.firstName, member.lastName]
          .filter(Boolean)
          .join(" ");
        return [member.membershipId, member.name?.trim() || structuredName || member.email];
      }),
    );
    return rows.map((row) => ({
      ...row,
      permissions: byDelegation.get(row.id) ?? [],
      delegatorName: nameByMembershipId.get(row.delegatorMembershipId) ?? null,
      delegateeName: nameByMembershipId.get(row.delegateeMembershipId) ?? null,
      lifecycle: resolveLifecycle(row, now),
    }));
  }

  private async listPage(
    orgId: string,
    userId: string,
    direction: DelegationDirection,
    query: ListDelegationsQuery,
  ) {
    const now = new Date();
    const actorMembership = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!actorMembership) {
      return {
        data: [],
        pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
      };
    }
    const actorMembershipId = actorMembership.id;
    const participantColumn =
      direction === "received"
        ? userDelegations.delegatorMembershipId
        : userDelegations.delegateeMembershipId;
    const actorColumn =
      direction === "received"
        ? userDelegations.delegateeMembershipId
        : userDelegations.delegatorMembershipId;
    const search = query.search?.trim();
    const searchPattern = search ? `%${escapeLike(search)}%` : null;
    const participantSearch = searchPattern
      ? or(
          ilike(userDelegations.reason, searchPattern),
          sql`EXISTS (
            SELECT 1
            FROM ${organizationMembers}
            INNER JOIN ${users} ON ${users.id} = ${organizationMembers.userId}
            WHERE ${organizationMembers.id} = ${participantColumn}
              AND ${organizationMembers.orgId} = ${orgId}
              AND (
                ${users.name} ILIKE ${searchPattern}
                OR ${users.email} ILIKE ${searchPattern}
                OR concat_ws(' ', ${users.firstName}, ${users.lastName}) ILIKE ${searchPattern}
              )
          )`,
        )
      : undefined;
    const conditions = and(
      eq(userDelegations.orgId, orgId),
      eq(actorColumn, actorMembershipId),
      direction === "received"
        ? and(
            eq(userDelegations.status, "ACTIVE"),
            lte(userDelegations.startsAt, now),
            gt(userDelegations.endsAt, now),
          )
        : undefined,
      participantSearch,
    );
    const offset = (query.page - 1) * query.limit;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select(delegationSelection)
        .from(userDelegations)
        .innerJoin(delegatorMember, joinDelegatorMember)
        .innerJoin(delegateeMember, joinDelegateeMember)
        .where(conditions)
        .orderBy(desc(userDelegations.createdAt), desc(userDelegations.id))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(userDelegations)
        .innerJoin(delegatorMember, joinDelegatorMember)
        .innerJoin(delegateeMember, joinDelegateeMember)
        .where(conditions),
    ]);
    const total = Number(totalRow?.total ?? 0);
    const data = await this.withPermissions(rows, now);

    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async list(
    orgId: string,
    userId: string,
    query: ListDelegationsQuery = { page: 1, limit: 20 },
  ) {
    return this.listPage(orgId, userId, "received", query);
  }

  async listGiven(
    orgId: string,
    delegatorId: string,
    query: ListDelegationsQuery = { page: 1, limit: 20 },
  ) {
    return this.listPage(orgId, delegatorId, "given", query);
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
