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
import { keysOf, buildRecord } from "./lib/typed-record";
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

const TIER_CACHE_TTL_SECONDS = 30;

const ENTITLEMENTS_CACHE_TTL = 60;

@Injectable()
export class PlanLimitsService {
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

  /**
   * The tier gates every paid feature and every quota, so a suspension, a downgrade or an expiry
   * has to stop being true everywhere at once. This used to be a per-process `Map` with a 30s TTL,
   * which `bust()` could only clear in the one process that happened to serve the mutation — every
   * sibling instance kept selling the cancelled plan until its own entry aged out. It lives in the
   * shared cache for the same reason the entitlements payload below it does.
   */
  async resolveTier(orgId: string): Promise<{ tier: PlanTier; plan: EffectivePlan }> {
    return this.cache.cached(
      PlanLimitsService.tierCacheKey(orgId),
      () => this.queryTier(orgId),
      TIER_CACHE_TTL_SECONDS,
    );
  }

  async bust(orgId: string): Promise<void> {
    await this.cache.invalidate(PlanLimitsService.tierCacheKey(orgId));
    await this.cache.invalidate(`billing:entitlements:${orgId}`);
  }

  private static tierCacheKey(orgId: string): string {
    return `billing:tier:${orgId}`;
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

    const limitKeys = keysOf(catalog);
    const limits = buildRecord(limitKeys, (key) => {
      let limit = catalog[key][plan];
      if (key === "members" && negotiatedSeats !== null) limit = negotiatedSeats;
      return { limit, used: usageRow[key] };
    });

    return {
      tier,
      plan,
      seatLimit,
      lockedModules: PLAN_LOCKED_MODULES[tier],
      features: PLAN_FEATURE_FLAGS[tier],
      limits,
    };
  }

  /**
   * The allowance itself, without asserting anything about it.
   *
   * `assertWithinLimit` is the right shape for a request a person made: it
   * throws, the handler unwinds, and the person is told to upgrade. It is the
   * wrong shape for an autonomous write, where throwing unwinds an ingest that
   * was carrying a customer's message -- refusing to record that an email
   * arrived, because a plan limit was reached, loses the message.
   *
   * So the autonomous path needs the number rather than the exception, and
   * decides for itself what to do with it. `null` means unlimited, which is the
   * catalogue's own convention and is passed through unchanged rather than
   * being flattened into a sentinel that the caller then has to decode.
   *
   * Deliberately no count: the population a limit governs is not the same
   * question as the allowance, and on the autonomous path it is not the same
   * answer either -- see the note in the inbound workflow.
   */
  async limitFor(orgId: string, key: LimitKey): Promise<number | null> {
    const { tier, plan } = await this.resolveTier(orgId);
    const limit = PLAN_LIMITS[key][plan];
    if (key === "members" && tier === "ENTERPRISE") {
      const negotiated = await this.fetchNegotiatedSeats(orgId);
      if (negotiated !== null) return negotiated;
    }
    return limit;
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
