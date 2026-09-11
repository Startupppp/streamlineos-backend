import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import {
  PLAN_LIMITS,
  PLAN_FEATURE_FLAGS,
  PLAN_LOCKED_MODULES,
  PLAN_LABELS,
  type EffectivePlan,
  type LimitKey,
  type PlanFeatureFlags,
  type PlanTier,
} from "./plan-entitlements.constants";
import { canUseFeature, minPlanFor, type Feature } from "../../ai/core/billing/feature-gates";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { NotificationsService } from "../../notifications/notifications.service";
import {
  fetchAllCounts,
  fetchCount,
  LIMIT_KEY_LABELS,
  type PlanLimitCountDeps,
} from "./lib/plan-limit-counts";
import { maybeAlertQuota, type QuotaAlertDeps } from "./lib/plan-quota-alerts";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

export interface EntitlementsDto {
  tier: PlanTier;
  plan: EffectivePlan;
  seatLimit: number | null;
  lockedModules: string[];
  features: PlanFeatureFlags;
  limits: Record<LimitKey, { limit: number | null; used: number }>;
}

interface TierCache {
  value: { tier: PlanTier; plan: EffectivePlan };
  expiresAt: number;
}

const TIER_CACHE_TTL_MS = 30_000;

const ENTITLEMENTS_CACHE_TTL = 60;

@Injectable()
export class PlanLimitsService {
  private readonly tierCache = new Map<string, TierCache>();
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    @Optional() private readonly notifications: NotificationsService | null,
  ) {}

  private get countDeps(): PlanLimitCountDeps {
    return { db: this.db, logger: this.logger };
  }

  private get alertDeps(): QuotaAlertDeps {
    return { db: this.db, cache: this.cache, notifications: this.notifications };
  }

  async resolveTier(orgId: string): Promise<{ tier: PlanTier; plan: EffectivePlan }> {
    const cached = this.tierCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.queryTier(orgId);
    this.tierCache.set(orgId, { value, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    if (this.tierCache.size > 2000) {
      const now = Date.now();
      for (const [key, entry] of this.tierCache) {
        if (entry.expiresAt <= now) {
          this.tierCache.delete(key);
        }
      }
    }
    return value;
  }

  async bust(orgId: string): Promise<void> {
    this.tierCache.delete(orgId);
    await this.cache.invalidate(`billing:entitlements:${orgId}`);
  }

  private async queryTier(orgId: string): Promise<{ tier: PlanTier; plan: EffectivePlan }> {
    const rows = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx.execute(
          sql`SELECT plan, status, trial_ends_at, created_at FROM subscriptions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`,
        ),
      { orgId },
    );
    const row = rows[0];
    if (!row) {
      return { tier: "FREE", plan: "FREE" };
    }

    const status = String(row["status"] ?? "");
    const plan = String(row["plan"] ?? "");
    const trialEndsAt = row["trial_ends_at"];

    if (status === "EXPIRED" || status === "CANCELLED") {
      return { tier: "FREE", plan: "FREE" };
    }

    if (status === "TRIAL") {
      const endsAt = trialEndsAt ? new Date(String(trialEndsAt)).getTime() : 0;
      if (endsAt < Date.now()) {
        return { tier: "FREE", plan: "FREE" };
      }
    }

    if (plan === "ENTERPRISE") {
      return { tier: "ENTERPRISE", plan: "ENTERPRISE" };
    }

    if (plan === "STARTER") {
      return { tier: "PAID", plan: "STARTER" };
    }

    if (plan === "PROFESSIONAL") {
      return { tier: "PAID", plan: "PROFESSIONAL" };
    }

    return { tier: "FREE", plan: "FREE" };
  }

  async getEntitlements(orgId: string): Promise<EntitlementsDto> {
    const { tier, plan } = await this.resolveTier(orgId);
    const cacheKey = `billing:entitlements:${orgId}`;
    return this.cache.cached(cacheKey, () => this.computeEntitlements(orgId, tier, plan), ENTITLEMENTS_CACHE_TTL);
  }

  private async computeEntitlements(orgId: string, tier: PlanTier, plan: EffectivePlan): Promise<EntitlementsDto> {
    const catalog = PLAN_LIMITS;

    const [usageRow, negotiatedSeats] = await Promise.all([
      fetchAllCounts(this.countDeps, orgId),
      tier === "ENTERPRISE" ? this.fetchNegotiatedSeats(orgId) : Promise.resolve(null),
    ]);

    const baseMembersLimit = catalog.members[plan];
    const seatLimit = negotiatedSeats !== null ? negotiatedSeats : baseMembersLimit;

    const limitKeys = Object.keys(catalog) as LimitKey[];
    const limits = {} as Record<LimitKey, { limit: number | null; used: number }>;
    for (const key of limitKeys) {
      let limit = catalog[key][plan];
      if (key === "members" && negotiatedSeats !== null) limit = negotiatedSeats;
      limits[key] = { limit, used: usageRow[key] };
    }

    return {
      tier,
      plan,
      seatLimit,
      lockedModules: PLAN_LOCKED_MODULES[tier],
      features: PLAN_FEATURE_FLAGS[tier],
      limits,
    };
  }

  async assertWithinLimit(
    orgId: string,
    key: LimitKey,
    increment = 1,
    executor?: DbOrTx,
  ): Promise<void> {
    const { tier, plan } = await this.resolveTier(orgId);
    let limit = PLAN_LIMITS[key][plan];
    if (key === "members" && tier === "ENTERPRISE") {
      const negotiated = await this.fetchNegotiatedSeats(orgId);
      if (negotiated !== null) limit = negotiated;
    }
    if (limit === null) return;

    let used: number;
    try {
      used = await fetchCount(this.countDeps, orgId, key, executor);
    } catch (err: unknown) {
      this.logger.error(`Limit count query failed`, { orgId, key, cause: err instanceof Error ? err.message : String(err) });
      throw new ServiceUnavailableException(`The ${LIMIT_KEY_LABELS[key]} count could not be determined. Try again shortly.`);
    }
    if (used + increment > limit) {
      const label = LIMIT_KEY_LABELS[key];
      throw new PaymentRequiredException({
        code: "QUOTA_EXCEEDED",
        message: `Your ${PLAN_LABELS[plan]} plan allows ${limit} ${label} and ${used} are already in use. Upgrade to add more.`,
        details: { limitKey: key, used, limit, upgradePath: "/settings/billing" },
      });
    }

    void maybeAlertQuota(this.alertDeps, orgId, key, used + increment, limit).catch((err: unknown) =>
      this.logger.warn(`quota alert failed [${orgId}/${key}]`, { err }),
    );
  }

  async checkFeature(orgId: string, feature: Feature): Promise<boolean> {
    const { plan } = await this.resolveTier(orgId);
    return canUseFeature(plan, feature);
  }

  async assertFeature(orgId: string, feature: Feature): Promise<void> {
    const { plan } = await this.resolveTier(orgId);
    if (!canUseFeature(plan, feature)) {
      const requiredPlan = minPlanFor(feature);
      const available = requiredPlan
        ? ` It is available from ${PLAN_LABELS[requiredPlan]}.`
        : "";
      throw new PaymentRequiredException({
        code: "FEATURE_NOT_AVAILABLE",
        message: `${feature} is not included in your ${PLAN_LABELS[plan]} plan.${available}`,
        details: { feature, requiredPlan, upgradePath: "/settings/billing" },
      });
    }
  }

  private async fetchNegotiatedSeats(orgId: string): Promise<number | null> {
    try {
      const rows = await this.db.execute(
        sql`SELECT negotiated_seats FROM enterprise_quotes WHERE org_id = ${orgId} AND status = 'ACCEPTED' ORDER BY accepted_at DESC LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return null;
      const seats = Number(row["negotiated_seats"] ?? 0);
      return seats > 0 ? seats : null;
    } catch (err: unknown) {
      this.logger.error(`Negotiated seats query failed`, { orgId, cause: err instanceof Error ? err.message : String(err) });
      throw new ServiceUnavailableException("Plan usage could not be determined. The write is refused until usage is verifiable.");
    }
  }

}
