import { Redis } from "@upstash/redis";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";

/**
 * Which Redis an organisation's entries live in, and under which key prefix.
 *
 * Cell placement is a property of the organisation, not of the cache: an org
 * pinned to a regional cell must read and write that cell's Redis, and its keys
 * carry that cell's prefix so two cells sharing one endpoint can never collide.
 * Both answers come from the region registry, both fail soft to the default
 * client and an unprefixed key, and both are cached per endpoint so a hot path
 * does not rebuild a client per request.
 *
 * Isolated here because it is the one part of the cache that knows about
 * regions at all. `CacheService` asks it two questions — "which client?" and
 * "what is this key called for this org?" — and is otherwise region-blind.
 */
export class CacheRegionRouter {
  private readonly regionalRedis = new Map<string, Redis>();

  constructor(
    private readonly fallback: Redis | null,
    private readonly commandTimeoutMs: number,
  ) {}

  async cellPrefixForOrg(orgId: string): Promise<string | null> {
    if (!hasRegionRegistry()) return null;
    try {
      return await getRegionRegistry().cacheKeyPrefixForOrg(orgId);
    } catch {
      return null;
    }
  }

  async redisForOrg(orgId: string): Promise<Redis | null> {
    if (!hasRegionRegistry()) return this.fallback;
    try {
      const config = await getRegionRegistry().cacheConfigForOrg(orgId);
      if (!config.upstashUrl || !config.upstashToken) return this.fallback;
      const existing = this.regionalRedis.get(config.upstashUrl);
      if (existing) return existing;
      const client = new Redis({
        url: config.upstashUrl,
        token: config.upstashToken,
        signal: () => AbortSignal.timeout(this.commandTimeoutMs),
        retry: { retries: 0, backoff: () => 0 },
      });
      this.regionalRedis.set(config.upstashUrl, client);
      return client;
    } catch {
      return this.fallback;
    }
  }

  async scopedKey(orgId: string, localKey: string): Promise<string> {
    const prefix = await this.cellPrefixForOrg(orgId);
    return prefix ? `${prefix}:${orgId}:${localKey}` : `${orgId}:${localKey}`;
  }
}
