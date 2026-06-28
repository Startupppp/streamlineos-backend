import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resourceGrants } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export const createResourceGrantSchema = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(36),
  principalType: z.enum(["user", "department"]).default("user"),
  principalId: z.string().min(1).max(36),
  permissionKey: z.string().min(1).max(128),
});

export type CreateResourceGrantInput = z.infer<typeof createResourceGrantSchema>;

@Injectable()
export class ResourceGrantsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, resourceType: string, resourceId: string) {
    return this.db
      .select()
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.orgId, orgId),
          eq(resourceGrants.resourceType, resourceType),
          eq(resourceGrants.resourceId, resourceId),
        ),
      );
  }

  async create(actor: CurrentUserContext, input: CreateResourceGrantInput) {
    if (!actor.isOrgOwner && !actor.permissions.includes("settings:rbac:manage")) {
      throw new ForbiddenException("Only org owners or RBAC managers can grant resource access");
    }

    const [grant] = await this.db
      .insert(resourceGrants)
      .values({
        orgId: actor.orgId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        principalType: input.principalType,
        principalId: input.principalId,
        permissionKey: input.permissionKey,
        grantedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();

    return grant ?? null;
  }

  async remove(actor: CurrentUserContext, grantId: string) {
    if (!actor.isOrgOwner && !actor.permissions.includes("settings:rbac:manage")) {
      throw new ForbiddenException("Only org owners or RBAC managers can revoke resource access");
    }

    await this.db
      .delete(resourceGrants)
      .where(and(eq(resourceGrants.id, grantId), eq(resourceGrants.orgId, actor.orgId)));

    return { success: true };
  }
}
