import type { Redis } from "@upstash/redis";
import { ServiceUnavailableException } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const REVOKED_SESSION_INDEX_KEY = "revoked:sessions:index";
export const REVOCATION_PRUNE_BATCH = 200;
/**
 * One MSET and one variadic ZADD per chunk. The Upstash REST transport puts the
 * whole command in one request body, so an unbounded id list is an unbounded
 * payload; a failed chunk then loses only its own tombstones.
 */
export const REVOCATION_WRITE_CHUNK = 256;

export function describeRedisFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
}

// Tombstones carry no TTL on purpose: volatile-lru only evicts keys that have one, and an evicted tombstone silently un-revokes a session. MSET cannot carry one at all.
export async function writeTombstones(redis: Redis, sessionIds: string[]): Promise<void> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const unique = [...new Set(sessionIds)];
  let unwritten = 0;
  for (let i = 0; i < unique.length; i += REVOCATION_WRITE_CHUNK) {
    const chunk = unique.slice(i, i + REVOCATION_WRITE_CHUNK);
    const [head, ...rest] = chunk;
    if (head === undefined) continue;
    const [written, indexed] = await Promise.allSettled([
      redis.mset(Object.fromEntries(chunk.map((id) => [`revoked:session:${id}`, true]))),
      redis.zadd(
        REVOKED_SESSION_INDEX_KEY,
        { score: expiresAt, member: head },
        ...rest.map((id) => ({ score: expiresAt, member: id })),
      ),
    ]);
    if (indexed?.status === "rejected")
      logger.error("session revocation index write failed", {
        sessions: chunk.length,
        cause: describeRedisFailure(indexed.reason),
      });
    if (written?.status === "rejected") {
      unwritten += chunk.length;
      logger.error("session revocation tombstone write failed", {
        sessions: chunk.length,
        cause: describeRedisFailure(written.reason),
      });
    }
  }
  if (unwritten > 0)
    throw new ServiceUnavailableException(
      `Could not publish ${String(unwritten)} session revocation(s)`,
    );
}

export async function pruneRevocations(redis: Redis): Promise<{ removed: number }> {
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
