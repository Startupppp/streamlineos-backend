import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { platformVisits } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { VisitInput } from "./dto/platform.schemas";

export interface VisitMeta {
  userAgent: string | null;
  country: string | null;
}

@Injectable()
export class PlatformService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async recordVisit(input: VisitInput, meta: VisitMeta) {
    try {
      const existing = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(eq(platformVisits.sessionToken, input.sessionToken))
        .then((r) => r[0]?.n ?? 0);

      await this.db.insert(platformVisits).values({
        sessionToken: input.sessionToken,
        path: input.path,
        referrer: input.referrer ?? null,
        userAgent: meta.userAgent,
        country: meta.country,
        isFirstVisit: existing === 0,
      });
    } catch (error) {
      logger.warn("[visit] beacon failed", { error });
    }
  }
}
