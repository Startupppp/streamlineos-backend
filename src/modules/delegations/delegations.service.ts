import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { userDelegations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export const createDelegationSchema = z.object({
  delegateeId: z.string().min(1),
  permissions: z.array(z.string().min(1)),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime(),
  reason: z.string().optional(),
});

export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;

@Injectable()
export class DelegationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  async create(orgId: string, delegatorId: string, body: CreateDelegationInput) {
    const endsAt = new Date(body.endsAt);
    if (endsAt <= new Date()) {
      throw new BadRequestException("endsAt must be in the future");
    }

    const [record] = await this.db
      .insert(userDelegations)
      .values({
        id: randomUUID(),
        orgId,
        delegatorId,
        delegateeId: body.delegateeId,
        permissions: body.permissions,
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        endsAt,
        reason: body.reason ?? null,
        status: "ACTIVE",
      })
      .returning();

    return record;
  }

  async revoke(orgId: string, id: string, actor: CurrentUserContext) {
    const [delegation] = await this.db
      .select()
      .from(userDelegations)
      .where(and(eq(userDelegations.id, id), eq(userDelegations.orgId, orgId)));

    if (!delegation) {
      throw new NotFoundException("Delegation not found");
    }

    if (!actor.isOrgOwner && delegation.delegatorId !== actor.userId) {
      throw new ForbiddenException("Only the delegator or an org owner can revoke a delegation");
    }

    const [updated] = await this.db
      .update(userDelegations)
      .set({
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: actor.userId,
      })
      .where(and(eq(userDelegations.id, id), eq(userDelegations.orgId, orgId)))
      .returning();

    return updated;
  }
}
