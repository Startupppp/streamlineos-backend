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
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { AccessService } from "../access/access.service";
import type {
  CreateDelegationInput,
  ListDelegationsQuery,
} from "./dto/delegation.schemas";
import {
  assertDelegationPolicy,
  assertDelegationTarget,
} from "./delegation-policy";

type DelegationRow = typeof userDelegations.$inferSelect;
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
    const participantIds = Array.from(
      new Set(rows.flatMap((row) => [row.delegatorId, row.delegateeId])),
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
          id: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(inArray(users.id, participantIds)),
    ]);
    const byDelegation = new Map<string, string[]>();
    for (const row of permissionRows) {
      const values = byDelegation.get(row.delegationId) ?? [];
      values.push(row.permissionKey);
      byDelegation.set(row.delegationId, values);
    }
    const nameById = new Map(
      participantRows.map((user) => {
        const structuredName = [user.firstName, user.lastName]
          .filter(Boolean)
          .join(" ");
        return [user.id, user.name?.trim() || structuredName || user.email];
      }),
    );
    return rows.map((row) => ({
      ...row,
      permissions: byDelegation.get(row.id) ?? [],
      delegatorName: nameById.get(row.delegatorId) ?? null,
      delegateeName: nameById.get(row.delegateeId) ?? null,
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
    const participantColumn =
      direction === "received"
        ? userDelegations.delegatorId
        : userDelegations.delegateeId;
    const actorColumn =
      direction === "received"
        ? userDelegations.delegateeId
        : userDelegations.delegatorId;
    const search = query.search?.trim();
    const searchPattern = search ? `%${escapeLike(search)}%` : null;
    const participantSearch = searchPattern
      ? or(
          ilike(userDelegations.reason, searchPattern),
          sql`EXISTS (
            SELECT 1
            FROM ${users}
            WHERE ${users.id} = ${participantColumn}
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
      eq(actorColumn, userId),
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
        .select()
        .from(userDelegations)
        .where(conditions)
        .orderBy(desc(userDelegations.createdAt), desc(userDelegations.id))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(userDelegations)
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
        const delegatee = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(organizationMembers.userId, body.delegateeId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
          columns: { id: true },
        });
        if (!delegatee) {
          throw new NotFoundException("Active delegatee not found");
        }
        const [created] = await tx
          .insert(userDelegations)
          .values({
            id: randomUUID(),
            orgId: actor.orgId,
            delegatorId: actor.userId,
            delegateeId: body.delegateeId,
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
        return { ...created, permissions: body.permissions };
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
          .select()
          .from(userDelegations)
          .where(
            and(
              eq(userDelegations.id, id),
              eq(userDelegations.orgId, orgId),
            ),
          );
        if (!delegation) {
          throw new NotFoundException("Delegation not found");
        }
        if (!actor.isOrgOwner && delegation.delegatorId !== actor.userId) {
          throw new ForbiddenException(
            "Only the delegator or an org owner can revoke a delegation",
          );
        }
        const permissionRows = await tx
          .select({ permissionKey: userDelegationPermissions.permissionKey })
          .from(userDelegationPermissions)
          .where(
            and(
              eq(userDelegationPermissions.orgId, orgId),
              eq(userDelegationPermissions.delegationId, id),
            ),
          )
          .orderBy(asc(userDelegationPermissions.permissionKey));
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
        return {
          updated: {
            ...updated,
            permissions: permissionRows.map((row) => row.permissionKey),
          },
          delegateeId: delegation.delegateeId,
        };
      },
      { orgId },
    );
    await this.invalidateDelegateeSession(result.delegateeId);
    const { updated } = result;
    return updated;
  }
}
