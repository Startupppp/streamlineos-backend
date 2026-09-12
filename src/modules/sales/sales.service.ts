import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc } from "drizzle-orm";
import {
  salesQuotas,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import {
  createCommissionRule,
  listCommissionRules,
  listCommissions,
  updateCommission,
  type CommissionDeps,
} from "./lib/sales-commissions";
import type {
  CommissionRuleCreateInput,
  CommissionListInput,
  QuotaListInput,
  QuotaCreateInput,
} from "./dto/sales.schemas";
import type { CommissionConflict, CommissionNotFound } from "./lib/sales-commissions";

export type { CommissionConflict, CommissionNotFound };

export type SalesForbidden = { error: "forbidden"; message: string };

export function isForbidden(value: unknown): value is SalesForbidden {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "forbidden"
  );
}

export function isNotFound(value: unknown): value is CommissionNotFound {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "not_found"
  );
}

export function isConflict(value: unknown): value is CommissionConflict {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "conflict"
  );
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  /** @see lib/sales-commissions.ts */
  listCommissionRules(orgId: string) {
    return listCommissionRules(this.commissionDeps, orgId);
  }

  /** @see lib/sales-commissions.ts */
  async createCommissionRule(orgId: string, input: CommissionRuleCreateInput) {
    return createCommissionRule(this.commissionDeps, orgId, input);
  }

  /** @see lib/sales-commissions.ts */
  listCommissions(orgId: string, filters: CommissionListInput) {
    return listCommissions(this.commissionDeps, orgId, filters);
  }

  /** @see lib/sales-commissions.ts */
  async updateCommission(orgId: string, commissionId: number, status: "approved" | "paid") {
    return updateCommission(this.commissionDeps, orgId, commissionId, status);
  }

  private get commissionDeps(): CommissionDeps {
    return { db: this.db, cache: this.cache };
  }

  listQuotas(orgId: string, filters: QuotaListInput) {
    return this.cache.cachedVersioned(
      `sales:quotas:${orgId}`,
      `${filters.userId ?? "*"}:${filters.period ?? "*"}`,
      async () => {
        const conditions = [eq(salesQuotas.orgId, orgId)];
        if (filters.userId) conditions.push(eq(salesQuotas.userId, filters.userId));
        if (filters.period) conditions.push(eq(salesQuotas.period, filters.period));

        const results = await this.db
          .select({
            id: salesQuotas.id,
            userId: salesQuotas.userId,
            userName: users.name,
            period: salesQuotas.period,
            startDate: salesQuotas.startDate,
            endDate: salesQuotas.endDate,
            targetRevenue: salesQuotas.targetRevenue,
            actualRevenue: salesQuotas.actualRevenue,
            notes: salesQuotas.notes,
            createdAt: salesQuotas.createdAt,
          })
          .from(salesQuotas)
          .leftJoin(users, eq(salesQuotas.userId, users.id))
          .where(and(...conditions))
          .orderBy(desc(salesQuotas.startDate))
          .limit(filters.limit ?? 20);

        return results.map((q) => ({
          ...q,
          attainmentPct:
            Number(q.targetRevenue) > 0
              ? Math.round((Number(q.actualRevenue) / Number(q.targetRevenue)) * 100)
              : 0,
        }));
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async createQuota(
    orgId: string,
    actor: CurrentUserContext,
    setById: string,
    input: QuotaCreateInput,
  ) {
    if (!(await this.access.holds(actor, "crm:targets:manage"))) {
      return { error: "forbidden", message: "Only managers can set quotas" } as SalesForbidden;
    }

    const [quota] = await this.db
      .insert(salesQuotas)
      .values({
        orgId,
        userId: input.userId,
        period: input.period,
        startDate: input.startDate,
        endDate: input.endDate,
        targetRevenue: input.targetRevenue,
        notes: input.notes ?? null,
        setById,
      })
      .returning();

    await this.cache.invalidateNamespace(`sales:quotas:${orgId}`);
    return quota;
  }
}
