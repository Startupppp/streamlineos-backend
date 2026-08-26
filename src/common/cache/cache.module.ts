import { Global, Logger, Module, OnModuleInit } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { CacheService, REDIS } from "./cache.service";
import { OrgHierarchyCacheService } from "./org-hierarchy-cache.service";

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (): Redis | null => {
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        return url && token ? new Redis({ url, token }) : null;
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
