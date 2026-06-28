import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { userRoles, users, roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export const createTemporaryAccessSchema = z.object({
  userId: z.string().min(1),
  roleId: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  reason: z.string().optional(),
});

export type CreateTemporaryAccessInput = z.infer<typeof createTemporaryAccessSchema>;

@Injectable()
export class TemporaryAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    const now = new Date();
    return this.db
      .select({
        id: userRoles.id,
        userId: userRoles.userId,
        userName: sql<string>`COALESCE(NULLIF(TRIM(CONCAT(COALESCE(${users.firstName}, ''), ' ', COALESCE(${users.lastName}, ''))), ''), ${users.email})`,
        roleId: userRoles.roleId,
        roleName: roles.name,
        expiresAt: userRoles.expiresAt,
        reason: userRoles.reason,
        assignedBy: userRoles.assignedBy,
        createdAt: userRoles.createdAt,
      })
      .from(userRoles)
      .leftJoin(users, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          eq(userRoles.orgId, orgId),
          isNotNull(userRoles.expiresAt),
          gt(userRoles.expiresAt, now),
        ),
      );
  }

  async create(actor: CurrentUserContext, body: CreateTemporaryAccessInput) {
    if (!actor.isOrgOwner && !actor.permissions.includes("settings:rbac:manage")) {
      throw new ForbiddenException("Only org owners or RBAC managers can assign temporary roles");
    }

    const [record] = await this.db
      .insert(userRoles)
      .values({
        orgId: actor.orgId,
        userId: body.userId,
        roleId: body.roleId,
        expiresAt: new Date(body.expiresAt),
        reason: body.reason ?? null,
        assignedBy: actor.userId,
      })
      .returning();

    return record;
  }

  async revoke(orgId: string, id: number) {
    await this.db
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.id, id),
          eq(userRoles.orgId, orgId),
          isNotNull(userRoles.expiresAt),
        ),
      );

    return { success: true };
  }
}
