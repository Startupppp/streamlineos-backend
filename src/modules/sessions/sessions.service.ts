import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { addDays } from "date-fns";
import { randomUUID } from "node:crypto";
import { userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import type { Redis } from "@upstash/redis";
import { isApiClientUserAgent, withClientInfo } from "../../common/http/parse-user-agent";

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const REVOKED_SESSION_INDEX_KEY = "revoked:sessions:index";
const REVOCATION_PRUNE_BATCH = 200;
/**
 * One MSET and one variadic ZADD per chunk. The Upstash REST transport puts the
 * whole command in one request body, so an unbounded id list is an unbounded
 * payload; a failed chunk then loses only its own tombstones.
 */
const REVOCATION_WRITE_CHUNK = 256;

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

    const rows = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      orderBy: [desc(userSessions.lastActive)],
      columns: { id: true, userAgent: true, ipAddress: true, lastActive: true, createdAt: true },
    });

    return rows.map((s) => ({
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

    await this.tombstone(active.map((s) => s.id));

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.userId, userId));

    return { revokedCount: active.length };
  }

  async revokeAllOthers(userId: string, currentSessionId: string) {
    const others = await this.db.query.userSessions.findMany({
      where: and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      columns: { id: true },
    });

    const toRevoke = others.filter((s) => s.id !== currentSessionId);

    if (toRevoke.length === 0) return { revokedCount: 0 };

    await this.tombstone(toRevoke.map((s) => s.id));

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

    await this.tombstone(ids);
  }

  // Tombstones carry no TTL on purpose: volatile-lru only evicts keys that have one, and an evicted tombstone silently un-revokes a session. MSET cannot carry one at all.
  async publishRevocations(sessionIds: string[]): Promise<void> {
    await this.tombstone(sessionIds);
  }

  private async tombstone(sessionIds: string[]): Promise<void> {
    if (!this.redis || sessionIds.length === 0) return;
    const redis = this.redis;
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    const unique = [...new Set(sessionIds)];
    for (let i = 0; i < unique.length; i += REVOCATION_WRITE_CHUNK) {
      const chunk = unique.slice(i, i + REVOCATION_WRITE_CHUNK);
      const [head, ...rest] = chunk;
      if (head === undefined) continue;
      await Promise.allSettled([
        redis.mset(Object.fromEntries(chunk.map((id) => [`revoked:session:${id}`, true]))),
        redis.zadd(
          REVOKED_SESSION_INDEX_KEY,
          { score: expiresAt, member: head },
          ...rest.map((id) => ({ score: expiresAt, member: id })),
        ),
      ]);
    }
  }

  async pruneExpiredRevocations(): Promise<{ removed: number }> {
    if (!this.redis) return { removed: 0 };
    const redis = this.redis;
    const now = Date.now();

    const expired = await redis.zrange<string[]>(REVOKED_SESSION_INDEX_KEY, 0, now, {
      byScore: true,
    });
    if (expired.length === 0) return { removed: 0 };

    for (let i = 0; i < expired.length; i += REVOCATION_PRUNE_BATCH) {
      const batch = expired.slice(i, i + REVOCATION_PRUNE_BATCH);
      await redis.del(...batch.map((id) => `revoked:session:${id}`));
    }
    await redis.zremrangebyscore(REVOKED_SESSION_INDEX_KEY, 0, now);

    return { removed: expired.length };
  }
}
