import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from "@nestjs/common";
import { sql, type Column, type SQL } from "drizzle-orm";
import { businessParties, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
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
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { readCount } from "./quota-counts";
import { seatCount } from "./seat-definition";

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

const QUOTA_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How many live customers a `*_party_map` accounts for, as a scalar subquery.
 *
 * `COUNT(*) FROM leads WHERE deleted_at IS NULL` counted the mirror, which is
 * wrong twice over now that Party is the record. A merge re-points the losing
 * legacy row's map row onto the survivor and refreshes it from there, so the
 * duplicate `leads` row is left alive holding the survivor's values — one
 * customer, charged against the plan twice. And `leads.deleted_at` is a derived
 * column: it is the Party's deletion that decides.
 *
 * Written as SQL rather than a query builder because it is interpolated into the
 * one statement that fetches all fourteen counts together; the alternative is
 * fourteen round trips or two shapes of the same count.
 */
function liveCustomerCount(partyIdColumn: Column, orgColumn: Column, orgId: string): SQL {
  return sql`SELECT count(distinct ${businessParties.partyId})::int
    FROM ${businessParties}
    JOIN ${partyIdColumn.table} ON ${partyIdColumn} = ${businessParties.partyId}
      AND ${orgColumn} = ${businessParties.organizationId}
    WHERE ${businessParties.organizationId} = ${orgId}
      AND ${businessParties.deletedAt} IS NULL`;
}

const LIMIT_KEY_LABELS: Record<LimitKey, string> = {
  members: "team members",
  projects: "projects",
  kbPages: "knowledge base pages",
  chatChannels: "chat channels",
  crmLeads: "CRM leads",
  crmContacts: "CRM contacts",
  crmDeals: "CRM deals",
  supportTickets: "support tickets",
  automations: "automations",
  signEnvelopes: "sign envelopes",
  surveys: "surveys",
  acctInvoices: "accounting invoices",
  hrCandidates: "HR candidates",
  hrJobPostings: "HR job postings",
};

@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    @Optional() private readonly notifications: NotificationsService | null,
  ) {}

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
      this.fetchAllCounts(orgId),
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

  private async fetchAllCounts(orgId: string): Promise<Record<LimitKey, number>> {
    try {
      const rows = await this.db.execute(sql`
        SELECT
          ${seatCount(orgId)}                                                                                                              AS members,
          (SELECT COUNT(*)::int FROM build.projects WHERE org_id = ${orgId})                                                              AS projects,
          (SELECT COUNT(*)::int FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL)                                             AS "kbPages",
          (SELECT COUNT(*)::int FROM chat_channels WHERE org_id = ${orgId})                                                               AS "chatChannels",
          (${liveCustomerCount(leadPartyMap.partyId, leadPartyMap.organizationId, orgId)})                                                AS "crmLeads",
          (${liveCustomerCount(contactPartyMap.partyId, contactPartyMap.organizationId, orgId)})                                          AS "crmContacts",
          (SELECT COUNT(*)::int FROM deals WHERE org_id = ${orgId})                                                                    AS "crmDeals",
          (SELECT COUNT(*)::int FROM support_tickets WHERE org_id = ${orgId})                                                             AS "supportTickets",
          (SELECT COUNT(*)::int FROM automation_rules WHERE org_id = ${orgId})                                                              AS automations,
          (SELECT COUNT(*)::int FROM sign_envelopes WHERE org_id = ${orgId})                                                              AS "signEnvelopes",
          (SELECT COUNT(*)::int FROM survey_forms WHERE org_id = ${orgId})                                                                AS surveys,
          (SELECT COUNT(*)::int FROM invoices WHERE org_id = ${orgId})                                                                  AS "acctInvoices",
          (SELECT COUNT(*)::int FROM candidates WHERE org_id = ${orgId})                                                                  AS "hrCandidates",
          (SELECT COUNT(*)::int FROM job_postings WHERE org_id = ${orgId})                                                                AS "hrJobPostings"
      `);
      const counts = {} as Record<LimitKey, number>;
      for (const key of Object.keys(LIMIT_KEY_LABELS) as LimitKey[]) counts[key] = readCount(rows, key);
      return counts;
    } catch (err: unknown) {
      this.logger.error(`Usage count query failed`, { orgId, cause: err instanceof Error ? err.message : String(err) });
      throw new ServiceUnavailableException("Plan usage could not be determined. The write is refused until usage is verifiable.");
    }
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
      used = await this.fetchCount(orgId, key, executor);
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

    void this.maybeAlertQuota(orgId, key, used + increment, limit).catch((err: unknown) =>
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

  private async fetchCount(
    orgId: string,
    key: LimitKey,
    executor?: DbOrTx,
  ): Promise<number> {
    // The caller's transaction is the only place a quota lock is held, so every count must read
    // through it — reading `this.db` outside it re-opens the check-then-insert race the lock closes.
    const countExecutor = executor ?? this.db;
    switch (key) {
      case "members": {
        const rows = await countExecutor.execute(sql`SELECT ${seatCount(orgId)} AS count`);
        return readCount(rows, "count");
      }
      case "projects": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM build.projects WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "kbPages": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL`,
        );
        return readCount(rows, "count");
      }
      case "chatChannels": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM chat_channels WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "crmLeads": {
        const rows = await countExecutor.execute(
          sql`SELECT (${liveCustomerCount(leadPartyMap.partyId, leadPartyMap.organizationId, orgId)}) AS count`,
        );
        return readCount(rows, "count");
      }
      case "crmContacts": {
        const rows = await countExecutor.execute(
          sql`SELECT (${liveCustomerCount(contactPartyMap.partyId, contactPartyMap.organizationId, orgId)}) AS count`,
        );
        return readCount(rows, "count");
      }
      case "crmDeals": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM deals WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "supportTickets": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM support_tickets WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "automations": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM automation_rules WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "signEnvelopes": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM sign_envelopes WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "surveys": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM survey_forms WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "acctInvoices": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM invoices WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "hrCandidates": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM candidates WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
      case "hrJobPostings": {
        const rows = await countExecutor.execute(
          sql`SELECT COUNT(*)::int AS count FROM job_postings WHERE org_id = ${orgId}`,
        );
        return readCount(rows, "count");
      }
    }
  }

  private crossedThresholds(afterCount: number, limit: number): number[] {
    const result: number[] = [];
    if (afterCount >= limit) result.push(100);
    if (afterCount >= limit * 0.8) result.push(80);
    return result;
  }

  private async findOrgOwnerForAlert(orgId: string): Promise<{ userId: string } | null> {
    try {
      const rows = await this.db.execute(
        sql`SELECT om.user_id FROM organization_members om
            INNER JOIN users u ON u.id = om.user_id
            WHERE om.org_id = ${orgId} AND om.is_owner = true AND u.is_active = true
            LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return null;
      const userId = String(row["user_id"] ?? "");
      return userId ? { userId } : null;
    } catch {
      return null;
    }
  }

  private async maybeAlertQuota(
    orgId: string,
    key: LimitKey,
    afterCount: number,
    limit: number,
  ): Promise<void> {
    if (!this.notifications) return;

    const thresholds = this.crossedThresholds(afterCount, limit);
    if (thresholds.length === 0) return;

    const owner = await this.findOrgOwnerForAlert(orgId);
    if (!owner) return;

    const label = LIMIT_KEY_LABELS[key];

    for (const pct of thresholds) {
      const dedupKey = `billing:quota-alert:${orgId}:${key}:${pct}`;
      const alreadySent = await this.cache.get<boolean>(dedupKey);
      if (alreadySent) continue;

      const is100 = pct === 100;
      await this.notifications.create({
        orgId,
        userId: owner.userId,
        type: is100 ? "WARNING" : "INFO",
        priority: is100 ? "HIGH" : "NORMAL",
        category: "BILLING",
        sourceModule: "billing",
        eventKey: is100 ? "billing.quota.exceeded" : "billing.quota.warning",
        title: is100
          ? `${label} limit reached (${afterCount}/${limit})`
          : `${label} at 80% of limit (${afterCount}/${limit})`,
        message: is100
          ? `Your workspace has used all ${limit} ${label}. New additions are now blocked. Upgrade your plan to continue.`
          : `Your workspace has used ${afterCount} of ${limit} ${label} (${Math.round((afterCount / limit) * 100)}%). Consider upgrading before you hit the limit.`,
        link: "/settings/billing",
      });

      await this.cache.set(dedupKey, true, QUOTA_ALERT_TTL_SECONDS);
    }
  }
}
