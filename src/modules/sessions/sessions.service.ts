import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import type { Redis } from "@upstash/redis";

const SESSION_TTL_SECONDS = 8 * 60 * 60;

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  async list(
    userId: string,
    currentSessionId: string,
    userAgent: string | undefined,
    ipAddress: string | undefined,
  ) {
    if (currentSessionId) {
      await this.db
        .update(userSessions)
        .set({ lastActive: new Date(), userAgent, ipAddress })
        .where(and(eq(userSessions.id, currentSessionId), eq(userSessions.userId, userId)));
    }

    const rows = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      orderBy: [desc(userSessions.lastActive)],
      columns: { id: true, userAgent: true, ipAddress: true, lastActive: true, createdAt: true },
    });

    return rows.map((s) => ({ ...s, isCurrent: s.id === currentSessionId }));
  }

  async revokeOne(userId: string, currentSessionId: string, targetSessionId: string) {
    if (targetSessionId === currentSessionId) {
      throw new BadRequestException("Cannot revoke your current session");
    }

    const target = await this.db.query.userSessions.findFirst({
      where: and(eq(userSessions.id, targetSessionId), eq(userSessions.userId, userId)),
    });

    if (!target) throw new NotFoundException("Session not found");

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.id, targetSessionId));

    if (this.redis) {
      await this.redis.set(`revoked:session:${targetSessionId}`, true, { ex: SESSION_TTL_SECONDS });
    }

    return { success: true };
  }

  async revokeAllOthers(userId: string, currentSessionId: string) {
    const others = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      columns: { id: true },
    });

    const toRevoke = others.filter((s) => s.id !== currentSessionId);

    if (toRevoke.length === 0) return { revokedCount: 0 };

    if (this.redis) {
      await Promise.all(
        toRevoke.map((s) =>
          this.redis!.set(`revoked:session:${s.id}`, true, { ex: SESSION_TTL_SECONDS }),
        ),
      );
    }

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.userId, userId));

    if (currentSessionId) {
      await this.db
        .update(userSessions)
        .set({ isRevoked: false })
        .where(eq(userSessions.id, currentSessionId));
    }

    return { revokedCount: toRevoke.length };
  }
}
