import { Global, Logger, Module, OnModuleInit } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { CacheService, REDIS, REDIS_COMMAND_TIMEOUT } from "./cache.service";
import { OrgHierarchyCacheService } from "./org-hierarchy-cache.service";

const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_COMMAND_TIMEOUT,
      useFactory: (): number => {
        const raw = process.env.REDIS_COMMAND_TIMEOUT_MS;
        if (raw === undefined || raw === "") return DEFAULT_COMMAND_TIMEOUT_MS;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 100)
          throw new Error(
            `REDIS_COMMAND_TIMEOUT_MS must be an integer >= 100; received: "${raw}"`,
          );
        return parsed;
      },
    },
    {
      provide: REDIS,
      inject: [REDIS_COMMAND_TIMEOUT],
      useFactory: (commandTimeoutMs: number): Redis | null => {
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        return url && token
          ? new Redis({
              url,
              token,
              signal: () => AbortSignal.timeout(commandTimeoutMs),
              retry: { retries: 0, backoff: () => 0 },
            })
          : null;
      },
    },
    CacheService,
    OrgHierarchyCacheService,
  ],
  exports: [CacheService, OrgHierarchyCacheService, REDIS],
})
export class CacheModule implements OnModuleInit {
  private readonly logger = new Logger(CacheModule.name);

  onModuleInit() {
    if (!process.env.UPSTASH_REDIS_REST_URL) {
      this.logger.warn("Redis is not configured — all caching is disabled");
      return;
    }
    this.logger.log(
      "Cache online. " +
        "Required eviction policy: volatile-lru (set in Upstash console). " +
        "Namespace version counters carry no TTL and must never be evicted. " +
        "Budget ceiling: ~35 GB (see cache-invalidation-matrix.ts for breakdown).",
    );
  }
}
