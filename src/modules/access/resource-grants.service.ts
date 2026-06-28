import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import { resourceGrants, type ResourceGrant } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";

export interface GrantResourceInput {
  resourceType: string;
  resourceId: string;
  principalType: "user" | "role";
  principalId: string;
  permissionKey: string;
}

export interface ListGrantsOptions {
  limit?: number;
  offset?: number;
}

export interface PaginatedGrants {
  data: ResourceGrant[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ResourceGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listGrants(
    orgId: string,
    resourceType: string,
    resourceId: string,
    options: ListGrantsOptions = {},
  ): Promise<PaginatedGrants> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = options.offset ?? 0;

    const where = and(
      eq(resourceGrants.orgId, orgId),
      eq(resourceGrants.resourceType, resourceType),
      eq(resourceGrants.resourceId, resourceId),
    );

    const [data, [{ value: total }]] = await Promise.all([
      this.db.query.resourceGrants.findMany({ where, limit, offset }),
      this.db.select({ value: count() }).from(resourceGrants).where(where),
    ]);

    return { data, total, limit, offset };
  }

  async grant(
    orgId: string,
    input: GrantResourceInput,
    grantedBy: string,
    callerManagesResource: boolean,
  ): Promise<ResourceGrant | null> {
    if (!callerManagesResource) {
      throw new ForbiddenException("You do not have manage access to this resource");
    }

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(resourceGrants)
        .values({
          orgId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          principalType: input.principalType,
          principalId: input.principalId,
          permissionKey: input.permissionKey,
          grantedBy,
        })
        .onConflictDoNothing()
        .returning();

      if (created) {
        await bumpPermissionsVersion(tx, orgId);
      }

      return created ?? null;
    }).then(async (created) => {
      if (created) {
        await this.invalidateGrantCache(orgId, input.principalType, input.principalId);
      }
      return created;
    });
  }

  async revoke(orgId: string, grantId: string): Promise<{ success: boolean }> {
    const existing = await this.db.query.resourceGrants.findFirst({
      where: and(eq(resourceGrants.id, grantId), eq(resourceGrants.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Grant not found");

    await this.db.transaction(async (tx) => {
      await tx
        .delete(resourceGrants)
        .where(and(eq(resourceGrants.id, grantId), eq(resourceGrants.orgId, orgId)));
      await bumpPermissionsVersion(tx, orgId);
    });

    await this.invalidateGrantCache(orgId, existing.principalType, existing.principalId);

    return { success: true };
  }

  async hasGrant(
    orgId: string,
    userId: string,
    resourceType: string,
    resourceId: string,
    permissionKey: string,
  ): Promise<boolean> {
    const grant = await this.db.query.resourceGrants.findFirst({
      where: and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.resourceType, resourceType),
        eq(resourceGrants.resourceId, resourceId),
        eq(resourceGrants.principalType, "user"),
        eq(resourceGrants.principalId, userId),
        eq(resourceGrants.permissionKey, permissionKey),
      ),
    });
    return !!grant;
  }

  private async invalidateGrantCache(
    orgId: string,
    principalType: string,
    principalId: string,
  ): Promise<void> {
    if (principalType === "user") {
      await this.cache.invalidatePattern(`access:perms:${orgId}:${principalId}:*`);
    } else {
      await this.cache.invalidatePattern(`access:perms:${orgId}:*`);
    }
  }
}
