import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { addDays } from "date-fns";
import { randomUUID } from "node:crypto";
import { userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import type { Redis } from "@upstash/redis";
import { isApiClientUserAgent, withClientInfo } from "../../common/http/parse-user-agent";
import { logger } from "../../common/logger/logger.service";
import { writeTombstones, pruneRevocations, describeRedisFailure } from "./session-revocation-helpers";

/**
 * The device list is a page, not a dump. Matches the admin twin
 * `UserProfileService.getUserSessions`, which has always read `.limit(50)`.
 */
export const SESSION_LIST_CAP = 50;

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
    if (currentSessionId && !currentSessionId.startsWith("pat:")) {
      const now = new Date();
      const incoming = userAgent ?? null;
      const incomingIsApiClient = isApiClientUserAgent(incoming);

      const existing = await this.db.query.userSessions.findFirst({
        where: and(eq(userSessions.id, currentSessionId), eq(userSessions.userId, userId)),
        columns: { id: true, userAgent: true },
      });

      if (!existing) {
        await this.db.insert(userSessions).values({
          id: currentSessionId,
          userId,
          userAgent: incoming,
          ipAddress: ipAddress ?? null,
          isRevoked: false,
          lastActive: now,
          expiresAt: addDays(now, 30),
        });
      } else {
        const storedIsApiClient = isApiClientUserAgent(existing.userAgent);
        const shouldOverwriteUa = !incomingIsApiClient || storedIsApiClient || existing.userAgent === null;

        await this.db
          .update(userSessions)
          .set({
            lastActive: now,
            ...(shouldOverwriteUa ? { userAgent: incoming, ipAddress: ipAddress ?? null } : {}),
          })
          .where(and(eq(userSessions.id, currentSessionId), eq(userSessions.userId, userId)));
      }
    }

    /**
     * The same "still active" predicate `enforceMaxSessions` uses below. The
     * asymmetry was the defect: that method has always excluded expired rows,
     * this one never did, so a session the user signed out of a month ago
     * rendered in Settings → Security as a live device with a working Revoke
     * button. Nothing prunes `user_sessions` and
     * `organizations.max_concurrent_sessions` is nullable with no default, so
     * without this the list grew one row per sign-in forever.
     *
     * `id` breaks the `lastActive` tie so the capped page is a stable
     * prefix — the cap must not return an arbitrary subset that changes
     * between two reads of the same state.
     */
    const listedAt = new Date();
    const rows = await this.db.query.userSessions.findMany({
      where: and(
        eq(userSessions.userId, userId),
        eq(userSessions.isRevoked, false),
        or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, listedAt)),
      ),
      orderBy: [desc(userSessions.lastActive), asc(userSessions.id)],
      limit: SESSION_LIST_CAP + 1,
      columns: { id: true, userAgent: true, ipAddress: true, lastActive: true, createdAt: true },
    });

    if (rows.length > SESSION_LIST_CAP) {
      // Never a silent truncation. One person holding more than a page of live
      // sessions is either an integration signing in on a loop or an attack,
      // and both need to be visible rather than quietly clipped.
      logger.warn("session list truncated at the page cap", {
        userId,
        cap: SESSION_LIST_CAP,
      });
    }

    return rows.slice(0, SESSION_LIST_CAP).map((s) => ({
      ...withClientInfo(s),
      isCurrent: s.id === currentSessionId,
    }));
  }

  async revokeOne(userId: string, currentSessionId: string, targetSessionId: string) {
    if (targetSessionId === currentSessionId) {
      throw new BadRequestException("Cannot revoke your current session");
    }

    const target = await this.db.query.userSessions.findFirst({
      columns: { id: true },
      where: and(eq(userSessions.id, targetSessionId), eq(userSessions.userId, userId)),
    });

    if (!target) throw new NotFoundException("Session not found");

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.id, targetSessionId));

    await this.tombstone([targetSessionId]);

    return { success: true };
  }

  async revokeAllForUser(userId: string) {
    const active = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      columns: { id: true },
    });

    if (active.length === 0) return { revokedCount: 0 };

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.userId, userId));

    await this.tombstone(active.map((s) => s.id));

    return { revokedCount: active.length };
  }

  async revokeAllOthers(userId: string, currentSessionId: string) {
    const others = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      columns: { id: true },
    });

    const toRevoke = others.filter((s) => s.id !== currentSessionId);

    if (toRevoke.length === 0) return { revokedCount: 0 };

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isRevoked, false),
          ne(userSessions.id, currentSessionId),
        ),
      );

    await this.tombstone(toRevoke.map((s) => s.id));

    return { revokedCount: toRevoke.length };
  }

  async create(params: {
    userId: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
    expiresAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(userSessions).values({
      id,
      userId: params.userId,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      deviceId: params.deviceId,
      expiresAt: params.expiresAt,
      isRevoked: false,
      lastActive: new Date(),
    });
    return id;
  }

  async revokeCurrent(userId: string, sessionId: string): Promise<void> {
    if (!sessionId || sessionId.startsWith("pat:")) return;

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)));

    await this.tombstone([sessionId]);
  }

  async enforceMaxSessions(
    userId: string,
    maxAllowed: number,
    keepId: string,
  ): Promise<void> {
    if (maxAllowed < 1) return;

    const now = new Date();
    const active = await this.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isRevoked, false),
          or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, now)),
        ),
      )
      .orderBy(asc(userSessions.lastActive));

    if (active.length <= maxAllowed) return;

    const evictable = active.filter((s) => s.id !== keepId);
    const toRevoke = evictable.slice(0, active.length - maxAllowed);
    if (toRevoke.length === 0) return;

    const ids = toRevoke.map((s) => s.id);
    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(and(eq(userSessions.userId, userId), inArray(userSessions.id, ids)));

    try {
      await this.tombstone(ids);
    } catch (err: unknown) {
      logger.error("session cap eviction left sessions untombstoned", {
        userId,
        sessions: ids.length,
        cause: describeRedisFailure(err),
      });
    }
  }

  async publishRevocations(sessionIds: string[]): Promise<void> {
    await this.tombstone(sessionIds);
  }

  private async tombstone(sessionIds: string[]): Promise<void> {
    if (!this.redis || sessionIds.length === 0) return;
    await writeTombstones(this.redis, sessionIds);
  }

  async pruneExpiredRevocations(): Promise<{ removed: number }> {
    if (!this.redis) return { removed: 0 };
    return pruneRevocations(this.redis);
  }
}
