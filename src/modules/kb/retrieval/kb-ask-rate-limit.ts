import { HttpException, HttpStatus } from "@nestjs/common";
import type { Redis } from "@upstash/redis";
import {
  effectiveRateLimit,
  rateLimitWindowSecs,
} from "../../../common/ratelimit/rate-limit.service";

export const KB_ASK_ORG_TIER = "kb:ask:org";

const KB_ASK_ORG_WINDOW_SCRIPT =
  "local hits = redis.call('INCR', KEYS[1]) " +
  "local ttl = redis.call('TTL', KEYS[1]) " +
  "if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end " +
  "return {hits, ttl}";

export function kbAskOrgKey(orgId: string): string {
  return `rl:kb:ask:org:${orgId}`;
}

export async function chargeKbAskOrgBudget(
  redis: Redis | null,
  orgId: string,
): Promise<void> {
  if (!redis) return;
  const windowSecs = rateLimitWindowSecs(KB_ASK_ORG_TIER);
  const [hits, ttlSecs] = await redis.eval<[string], [number, number]>(
    KB_ASK_ORG_WINDOW_SCRIPT,
    [kbAskOrgKey(orgId)],
    [String(windowSecs)],
  );
  if (hits <= effectiveRateLimit(KB_ASK_ORG_TIER)) return;
  throw new HttpException(
    {
      message: "Org Ask rate limit exceeded",
      retryAfterSecs: ttlSecs > 0 ? ttlSecs : windowSecs,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
