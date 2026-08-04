import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizationMembers, userDelegations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AccessService } from "../access/access.service";
import type { CreateDelegationInput } from "./dto/delegation.schemas";
import { assertDelegationPolicy } from "./delegation-policy";

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async list(orgId: string, userId: string) {
    const now = new Date();
    return this.db
      .select()
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegateeId, userId),
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, now),
          gt(userDelegations.endsAt, now),
        ),
      );
  }

  async listGiven(orgId: string, delegatorId: string) {
    return this.db
      .select()
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          eq(userDelegations.delegatorId, delegatorId),
        ),
      );
  }

  async create(actor: CurrentUserContext, body: CreateDelegationInput) {
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
            permissions: body.permissions,
            startsAt,
            endsAt,
            reason: body.reason ?? null,
            status: "ACTIVE",
          })
          .returning();
        await bumpPermissionsVersion(tx, actor.orgId);
        return created;
      },
      { orgId: actor.orgId },
    );
    await this.cache.invalidate(CACHE_KEYS.userSession(body.delegateeId));
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
        return { updated, delegateeId: delegation.delegateeId };
      },
      { orgId },
    );
    await this.cache.invalidate(CACHE_KEYS.userSession(result.delegateeId));
    const { updated } = result;
    return updated;
  }
}
