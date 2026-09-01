import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetRates,
  timesheetRateCards,
  organizationMembers,
  projectMembers,
  projects,
} from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { pickBestRate, type RateMatchQuery } from "./lib/rate-match";

export type RateQuery = RateMatchQuery;

export interface ResolvedRate {
  billRate: number | null;
  costRate: number | null;
  currency: string;
  source: "RATE_CARD" | "PROJECT_MEMBER" | null;
}

@Injectable()
export class RateResolverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async resolve(orgId: string, query: RateQuery): Promise<ResolvedRate> {
    const [rates, defaultCurrency] = await Promise.all([
      this.getRates(orgId),
      this.getDefaultCurrency(orgId),
    ]);

    const best = pickBestRate(rates, query);
    if (!best) return this.fallbackToMember(orgId, query, defaultCurrency);

    return {
      billRate: parseFloat(best.billRate),
      costRate: best.costRate ? parseFloat(best.costRate) : null,
      currency: best.currency,
      source: "RATE_CARD",
    };
  }

  async resolveMany(
    orgId: string,
    queries: RateQuery[],
  ): Promise<ResolvedRate[]> {
    if (queries.length === 0) return [];

    const [rates, defaultCurrency] = await Promise.all([
      this.getRates(orgId),
      this.getDefaultCurrency(orgId),
    ]);

    const cardResults = queries.map((query) => {
      const best = pickBestRate(rates, query);
      return best
        ? {
            billRate: parseFloat(best.billRate),
            costRate: best.costRate ? parseFloat(best.costRate) : null,
            currency: best.currency,
            source: "RATE_CARD" as ResolvedRate["source"],
          }
        : null;
    });

    const fallbackPairs: { projectId: number; membershipId: number }[] = [];
    queries.forEach((query, i) => {
      if (
        cardResults[i] == null &&
        query.projectId != null &&
        query.userMembershipId != null
      ) {
        fallbackPairs.push({
          projectId: query.projectId,
          membershipId: query.userMembershipId,
        });
      }
    });

    const memberRateByKey = new Map<string, number>();
    if (fallbackPairs.length > 0) {
      const membershipIds = [...new Set(fallbackPairs.map((p) => p.membershipId))];
      const memberRows = await this.db
        .select({
          membershipId: organizationMembers.id,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.id, membershipIds),
          ),
        )
        .limit(membershipIds.length);

      const projectIds = [...new Set(fallbackPairs.map((p) => p.projectId))];

      if (memberRows.length > 0) {
        const pmRows = await this.db
          .select({
            projectId: projectMembers.projectId,
            membershipId: projectMembers.membershipId,
            hourlyRate: projectMembers.hourlyRate,
          })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(
            and(
              eq(projects.orgId, orgId),
              inArray(projectMembers.projectId, projectIds),
              inArray(projectMembers.membershipId, membershipIds),
            ),
          );

        const pmRateByProjectUser = new Map(
          pmRows
            .filter((r) => parseFloat(r.hourlyRate) > 0)
            .map((r) => [`${r.projectId}|${r.membershipId}`, parseFloat(r.hourlyRate)]),
        );

        for (const pair of fallbackPairs) {
          const rate = pmRateByProjectUser.get(`${pair.projectId}|${pair.membershipId}`);
          if (rate !== undefined) {
            memberRateByKey.set(`${pair.projectId}|${pair.membershipId}`, rate);
          }
        }
      }
    }

    return queries.map((query, i) => {
      const fromCard = cardResults[i];
      if (fromCard) return fromCard;
      const memberRate =
        query.projectId != null && query.userMembershipId != null
          ? memberRateByKey.get(`${query.projectId}|${query.userMembershipId}`)
          : undefined;
      if (memberRate !== undefined) {
        return {
          billRate: memberRate,
          costRate: null,
          currency: defaultCurrency,
          source: "PROJECT_MEMBER",
        };
      }
      return { billRate: null, costRate: null, currency: defaultCurrency, source: null };
    });
  }

  private async getRates(orgId: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.timesheetRatesNamespace(orgId),
      "rates",
      () =>
        this.db
          .select()
          .from(timesheetRates)
          .where(eq(timesheetRates.orgId, orgId)),
      CACHE_TTL.MEDIUM,
    );
  }

  async getDefaultCurrency(orgId: string): Promise<string> {
    const [defaultCard] = await this.db
      .select({ currency: timesheetRateCards.currency })
      .from(timesheetRateCards)
      .where(
        and(
          eq(timesheetRateCards.orgId, orgId),
          eq(timesheetRateCards.isDefault, true),
        ),
      )
      .limit(1);

    return defaultCard?.currency ?? "USD";
  }

  private async fallbackToMember(
    orgId: string,
    query: RateQuery,
    defaultCurrency: string,
  ): Promise<ResolvedRate> {
    if (query.projectId && query.userMembershipId) {
      const [member] = await this.db
        .select({ membershipId: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, query.userMembershipId),
          ),
        )
        .limit(1);

      if (member) {
        const [pm] = await this.db
          .select({ hourlyRate: projectMembers.hourlyRate })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(
            and(
              eq(projects.orgId, orgId),
              eq(projectMembers.projectId, query.projectId),
              eq(projectMembers.membershipId, member.membershipId),
            ),
          )
          .limit(1);

        if (pm && parseFloat(pm.hourlyRate) > 0) {
          return {
            billRate: parseFloat(pm.hourlyRate),
            costRate: null,
            currency: defaultCurrency,
            source: "PROJECT_MEMBER",
          };
        }
      }
    }

    return { billRate: null, costRate: null, currency: defaultCurrency, source: null };
  }
}
