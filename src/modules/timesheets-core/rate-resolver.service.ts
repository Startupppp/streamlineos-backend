import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
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

  async resolveMany(orgId: string, queries: RateQuery[]): Promise<ResolvedRate[]> {
    if (queries.length === 0) return [];

    const rates = await this.db
      .select()
      .from(timesheetRates)
      .where(eq(timesheetRates.orgId, orgId));

    const defaultCurrency = this.getDefaultCurrency(orgId);

    const cardResults = queries.map((query) => {
      const best = pickBestRate(rates, query);
      return best
        ? { billRate: parseFloat(best.billRate), currency: best.currency, source: "RATE_CARD" as string | null }
        : null;
    });

    const fallbackPairs: { projectId: number; userId: string }[] = [];
    queries.forEach((query, i) => {
      if (cardResults[i] == null && query.projectId != null && query.userId != null) {
        fallbackPairs.push({ projectId: query.projectId, userId: query.userId });
      }
    });

    const memberRateByKey = new Map<string, number>();
    if (fallbackPairs.length > 0) {
      const memberRows = await this.db
        .select({
          projectId: projectMembers.projectId,
          userId: projectMembers.userId,
          hourlyRate: projectMembers.hourlyRate,
        })
        .from(projectMembers)
        .where(
          and(
            inArray(projectMembers.projectId, [...new Set(fallbackPairs.map((p) => p.projectId))]),
            inArray(projectMembers.userId, [...new Set(fallbackPairs.map((p) => p.userId))]),
          ),
        );

      for (const row of memberRows) {
        const rate = parseFloat(row.hourlyRate);
        if (rate > 0) memberRateByKey.set(`${row.projectId}|${row.userId}`, rate);
      }
    }

    return queries.map((query, i) => {
      const fromCard = cardResults[i];
      if (fromCard) return fromCard;
      const memberRate =
        query.projectId != null && query.userId != null
          ? memberRateByKey.get(`${query.projectId}|${query.userId}`)
          : undefined;
      if (memberRate !== undefined) {
        return { billRate: memberRate, currency: defaultCurrency, source: "PROJECT_MEMBER" };
      }
      return { billRate: null, currency: defaultCurrency, source: null };
    });
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
