import { Global, Module } from "@nestjs/common";
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
export class CacheModule {}
