import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { resourceGrants, type ResourceGrant } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";

export interface GrantResourceInput {
  resourceType: string;
  resourceId: string;
  principalType: "user" | "role";
  principalId: string;
  permissionKey: string;
}

@Injectable()
export class ResourceGrantsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listGrants(orgId: string, resourceType: string, resourceId: string): Promise<ResourceGrant[]> {
    return this.db.query.resourceGrants.findMany({
      where: and(
        eq(resourceGrants.orgId, orgId),
        eq(resourceGrants.resourceType, resourceType),
        eq(resourceGrants.resourceId, resourceId),
      ),
    });
  }

  async grant(orgId: string, input: GrantResourceInput, grantedBy: string): Promise<ResourceGrant | null> {
    const [created] = await this.db
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
      await this.invalidateGrantCache(orgId, input.principalType, input.principalId);
    }
    return created ?? null;
  }

  async revoke(orgId: string, grantId: string): Promise<{ success: boolean }> {
    const existing = await this.db.query.resourceGrants.findFirst({
      where: and(eq(resourceGrants.id, grantId), eq(resourceGrants.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Grant not found");
    await this.db.delete(resourceGrants).where(eq(resourceGrants.id, grantId));
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
