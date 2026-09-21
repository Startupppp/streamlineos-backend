import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { addMinutes } from "date-fns";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import {
  impersonationSessions,
  organizationMembers,
  users,
} from "../../db/schema";
import { JwtKeyringService } from "../../common/auth/jwt-keyring.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { StartImpersonationResponse } from "./dto/impersonation-response.schemas";

const IMPERSONATION_TTL_MINUTES = 30;
const IMPERSONATION_SESSION_TOMBSTONE_KEY = (id: string) =>
  `revoked:impersonation:${id}`;

@Injectable()
export class ImpersonationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly keyring: JwtKeyringService,
    private readonly audit: AuditService,
  ) {}

  async start(
    actor: CurrentUserContext,
    targetUserId: string,
  ): Promise<StartImpersonationResponse> {
    if (actor.impersonation) {
      throw new BadRequestException("Nested impersonation is not allowed");
    }

    if (actor.userId === targetUserId) {
      throw new BadRequestException("Cannot impersonate yourself");
    }

    const [targetMember] = await this.db
      .select({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        isOwner: organizationMembers.isOwner,
        status: organizationMembers.status,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, targetUserId),
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (!targetMember) {
      throw new NotFoundException("Target user not found in this organization");
    }

    if (targetMember.isOwner && !actor.isOrgOwner) {
      throw new ForbiddenException(
        "Only the organization owner may impersonate the organization owner",
      );
    }

    const [targetUser] = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw new NotFoundException("Target user not found");
    }

    const impersonationSessionId = randomUUID();
    const sessionId = randomUUID();
    const expiresAt = addMinutes(new Date(), IMPERSONATION_TTL_MINUTES);

    await this.db.insert(impersonationSessions).values({
      id: impersonationSessionId,
      orgId: actor.orgId,
      actorUserId: actor.userId,
      targetUserId,
      sessionId,
      originalSessionId: actor.sessionId,
      isRevoked: false,
      expiresAt,
    });

    const token = await this.keyring.signImpersonationToken({
      sub: targetUserId,
      orgId: actor.orgId,
      sessionId,
      impersonation: {
        realActorUserId: actor.userId,
        realSessionId: actor.sessionId,
        impersonationSessionId,
      },
    });

    await this.audit.logCriticalOutsideTransaction({
      action: "impersonation.start",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: targetUserId,
      targetType: "user",
      metadata: {
        impersonationSessionId,
        targetUserId,
      },
    });

    return {
      token,
      targetUser: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
      },
      expiresAt: expiresAt.toISOString(),
      impersonationSessionId,
    };
  }

  async stop(
    actor: CurrentUserContext,
    impersonationSessionId: string,
  ): Promise<{ success: boolean }> {
    const [session] = await this.db
      .select({
        id: impersonationSessions.id,
        isRevoked: impersonationSessions.isRevoked,
      })
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.id, impersonationSessionId),
          eq(impersonationSessions.orgId, actor.orgId),
          eq(impersonationSessions.actorUserId, actor.userId),
        ),
      )
      .limit(1);

    if (!session) {
      throw new NotFoundException("Impersonation session not found");
    }

    if (!session.isRevoked) {
      await this.db
        .update(impersonationSessions)
        .set({ isRevoked: true, endedAt: new Date() })
        .where(
          and(
            eq(impersonationSessions.id, impersonationSessionId),
            eq(impersonationSessions.orgId, actor.orgId),
            eq(impersonationSessions.actorUserId, actor.userId),
          ),
        );

      if (this.redis) {
        await this.redis.set(
          IMPERSONATION_SESSION_TOMBSTONE_KEY(impersonationSessionId),
          true,
        );
      }
    }

    await this.audit.logCriticalOutsideTransaction({
      action: "impersonation.stop",
      userId: actor.userId,
      orgId: actor.orgId,
      metadata: { impersonationSessionId },
    });

    return { success: true };
  }
}
