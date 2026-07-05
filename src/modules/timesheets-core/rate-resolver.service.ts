import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetRates, projectMembers } from "../../db/schema";
import { pickBestRate, type RateMatchQuery } from "./lib/rate-match";

export type RateQuery = RateMatchQuery;

export interface ResolvedRate {
  billRate: number | null;
  currency: string;
  source: string | null;
}

@Injectable()
export class RateResolverService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolve(orgId: string, query: RateQuery): Promise<ResolvedRate> {
    const rates = await this.db
      .select()
      .from(timesheetRates)
      .where(eq(timesheetRates.orgId, orgId));

    const defaultCurrency = this.getDefaultCurrency(orgId);

    const best = pickBestRate(rates, query);
    if (!best) return this.fallbackToMember(orgId, query, defaultCurrency);

    return {
      billRate: parseFloat(best.billRate),
      currency: best.currency,
      source: "RATE_CARD",
    };
  }

  private async fallbackToMember(
    _orgId: string,
    query: RateQuery,
    defaultCurrency: string,
  ): Promise<ResolvedRate> {
    if (query.projectId && query.userId) {
      const [member] = await this.db
        .select({ hourlyRate: projectMembers.hourlyRate })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, query.projectId),
            eq(projectMembers.userId, query.userId),
          ),
        )
        .limit(1);

      if (member && parseFloat(member.hourlyRate) > 0) {
        return {
          billRate: parseFloat(member.hourlyRate),
          currency: defaultCurrency,
          source: "PROJECT_MEMBER",
        };
      }
    }

    return { billRate: null, currency: defaultCurrency, source: null };
  }

  private getDefaultCurrency(_orgId: string): string {
    return "USD";
  }
}
