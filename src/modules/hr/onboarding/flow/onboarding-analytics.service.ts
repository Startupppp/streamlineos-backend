import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { onboardingAnalyticsEvents } from "../../../../db/schema";

export interface TrackOptions {
  source?: string;
  stepKey?: string;
  moduleKey?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class OnboardingAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async track(orgId: string, userId: string | null, eventType: string, opts: TrackOptions = {}) {
    await this.db.insert(onboardingAnalyticsEvents).values({
      orgId,
      userId,
      eventType,
      source: opts.source,
      stepKey: opts.stepKey,
      moduleKey: opts.moduleKey,
      metadata: opts.metadata ?? {},
    });
  }

  async recentEvents(orgId: string, sinceDays = 30, limit = 200) {
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    return this.db.query.onboardingAnalyticsEvents.findMany({
      where: and(eq(onboardingAnalyticsEvents.orgId, orgId), gte(onboardingAnalyticsEvents.createdAt, since)),
      orderBy: desc(onboardingAnalyticsEvents.createdAt),
      limit,
    });
  }
}
