import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { buildSupportDashboard } from "./lib/support-dashboard";

@Injectable()
export class CrmSupportDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getSupportDashboard(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.supportDashboard(orgId),
      () => buildSupportDashboard(this.db, orgId),
      CACHE_TTL.MEDIUM,
    );
  }

}
