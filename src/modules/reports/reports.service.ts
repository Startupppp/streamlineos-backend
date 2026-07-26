import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { candidates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getSourceEffectiveness(orgId: string) {
    return this.cache.cached(
      `reports:source-effectiveness:${orgId}`,
      async () => {
        const rows = await this.db
          .select({
            source: sql<string>`COALESCE(${candidates.source}, 'DIRECT')`,
            total: sql<number>`COUNT(*)::int`,
            hired: sql<number>`COUNT(*) FILTER (WHERE ${candidates.status} = 'HIRED')::int`,
            rejected: sql<number>`COUNT(*) FILTER (WHERE ${candidates.status} = 'REJECTED')::int`,
          })
          .from(candidates)
          .where(eq(candidates.orgId, orgId))
          .groupBy(sql`COALESCE(${candidates.source}, 'DIRECT')`)
          .orderBy(sql`COUNT(*) DESC`);

        return rows.map((r) => ({
          source: r.source,
          total: r.total,
          hired: r.hired,
          rejected: r.rejected,
          hireRate: r.total > 0 ? Math.round((r.hired / r.total) * 100) : 0,
        }));
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
