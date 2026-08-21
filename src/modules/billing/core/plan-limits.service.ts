import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
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

const QUOTA_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;

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
  private readonly tierCache = new Map<string, TierCache>();
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    @Optional() private readonly notifications: NotificationsService | null,
  ) {}

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
          (SELECT COUNT(*)::int FROM organization_members WHERE org_id = ${orgId})                                                         AS members,
          (SELECT COUNT(*)::int FROM build.projects WHERE org_id = ${orgId})                                                              AS projects,
          (SELECT COUNT(*)::int FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL)                                             AS "kbPages",
          (SELECT COUNT(*)::int FROM chat_channels WHERE org_id = ${orgId})                                                               AS "chatChannels",
          (SELECT COUNT(*)::int FROM leads WHERE org_id = ${orgId} AND deleted_at IS NULL)                                                AS "crmLeads",
          (SELECT COUNT(*)::int FROM contacts WHERE org_id = ${orgId} AND deleted_at IS NULL)                                             AS "crmContacts",
          (SELECT COUNT(*)::int FROM deals WHERE org_id = ${orgId})                                                                    AS "crmDeals",
          (SELECT COUNT(*)::int FROM support_tickets WHERE org_id = ${orgId})                                                             AS "supportTickets",
          (SELECT COUNT(*)::int FROM automation_rules WHERE org_id = ${orgId})                                                              AS automations,
          (SELECT COUNT(*)::int FROM sign_envelopes WHERE org_id = ${orgId})                                                              AS "signEnvelopes",
          (SELECT COUNT(*)::int FROM survey_forms WHERE org_id = ${orgId})                                                                AS surveys,
          (SELECT COUNT(*)::int FROM invoices WHERE org_id = ${orgId})                                                                  AS "acctInvoices",
          (SELECT COUNT(*)::int FROM candidates WHERE org_id = ${orgId})                                                                  AS "hrCandidates",
          (SELECT COUNT(*)::int FROM job_postings WHERE org_id = ${orgId})                                                                AS "hrJobPostings"
      `);
      const row = rows[0];
      if (!row) return this.zeroCounts();
      return {
        members:        Number(row["members"] ?? 0),
        projects:       Number(row["projects"] ?? 0),
        kbPages:        Number(row["kbPages"] ?? 0),
        chatChannels:   Number(row["chatChannels"] ?? 0),
        crmLeads:       Number(row["crmLeads"] ?? 0),
        crmContacts:    Number(row["crmContacts"] ?? 0),
        crmDeals:       Number(row["crmDeals"] ?? 0),
        supportTickets: Number(row["supportTickets"] ?? 0),
        automations:    Number(row["automations"] ?? 0),
        signEnvelopes:  Number(row["signEnvelopes"] ?? 0),
        surveys:        Number(row["surveys"] ?? 0),
        acctInvoices:   Number(row["acctInvoices"] ?? 0),
        hrCandidates:   Number(row["hrCandidates"] ?? 0),
        hrJobPostings:  Number(row["hrJobPostings"] ?? 0),
      };
    } catch {
      return this.zeroCounts();
    }
  }

  private zeroCounts(): Record<LimitKey, number> {
    return {
      members: 0, projects: 0, kbPages: 0, chatChannels: 0,
      crmLeads: 0, crmContacts: 0, crmDeals: 0, supportTickets: 0,
      automations: 0, signEnvelopes: 0, surveys: 0, acctInvoices: 0,
      hrCandidates: 0, hrJobPostings: 0,
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

    const used = await this.fetchCount(orgId, key, executor);
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
    } catch {
      return null;
    }
  }

  private async fetchCount(
    orgId: string,
    key: LimitKey,
    executor?: DbOrTx,
  ): Promise<number> {
    switch (key) {
      case "members": {
        const rows = await (executor ?? this.db).execute(sql`
          SELECT (
            (SELECT COUNT(*)::int FROM organization_members WHERE org_id = ${orgId}) +
            (SELECT COUNT(*)::int FROM invitations
             WHERE org_id = ${orgId}
               AND status = 'PENDING'
               AND accepted_at IS NULL
               AND expires_at > NOW())
          )::int AS count
        `);
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "projects": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM build.projects WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "kbPages": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM kb_pages WHERE org_id = ${orgId} AND deleted_at IS NULL`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "chatChannels": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM chat_channels WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "crmLeads": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM leads WHERE org_id = ${orgId} AND deleted_at IS NULL`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "crmContacts": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM contacts WHERE org_id = ${orgId} AND deleted_at IS NULL`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "crmDeals": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM deals WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "supportTickets": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM support_tickets WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "automations": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM automation_rules WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "signEnvelopes": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM sign_envelopes WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "surveys": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM survey_forms WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "acctInvoices": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM invoices WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "hrCandidates": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM candidates WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "hrJobPostings": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM job_postings WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
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
