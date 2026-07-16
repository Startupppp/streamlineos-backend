import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  PLAN_LIMITS,
  PLAN_FEATURE_FLAGS,
  PLAN_LOCKED_MODULES,
  PLAN_LABELS,
  LIMIT_HUMAN_LABELS,
  type EffectivePlan,
  type LimitKey,
  type PlanFeatureFlags,
  type PlanTier,
} from "./plan-entitlements.constants";

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

@Injectable()
export class PlanLimitsService {
  private readonly tierCache = new Map<string, TierCache>();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolveTier(orgId: string): Promise<{ tier: PlanTier; plan: EffectivePlan }> {
    const cached = this.tierCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.queryTier(orgId);
    this.tierCache.set(orgId, { value, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    return value;
  }

  private async queryTier(orgId: string): Promise<{ tier: PlanTier; plan: EffectivePlan }> {
    const rows = await this.db.execute(
      sql`SELECT plan, status, trial_ends_at FROM subscriptions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`,
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
    const catalog = PLAN_LIMITS;
    const limitKeys = Object.keys(catalog) as LimitKey[];

    const [usageCounts, negotiatedSeats] = await Promise.all([
      Promise.all(
        limitKeys.map(async (key) => {
          try {
            const count = await this.fetchCount(orgId, key);
            return { key, count };
          } catch {
            return { key, count: 0 };
          }
        }),
      ),
      this.fetchNegotiatedSeats(orgId),
    ]);

    const baseMembersLimit = catalog.members[plan];
    const seatLimit = negotiatedSeats !== null ? negotiatedSeats : baseMembersLimit;

    const limits = {} as Record<LimitKey, { limit: number | null; used: number }>;
    for (const { key, count } of usageCounts) {
      let limit = catalog[key][plan];
      if (key === "members" && negotiatedSeats !== null) {
        limit = negotiatedSeats;
      }
      limits[key] = { limit, used: count };
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

  async assertWithinLimit(orgId: string, key: LimitKey, increment = 1): Promise<void> {
    const { plan } = await this.resolveTier(orgId);
    const limit = PLAN_LIMITS[key][plan];
    if (limit === null) return;

    const used = await this.fetchCount(orgId, key);
    if (used + increment > limit) {
      const planLabel = PLAN_LABELS[plan];
      const humanLabel = LIMIT_HUMAN_LABELS[key];
      throw new ForbiddenException(
        `Your ${planLabel} plan allows ${limit} ${humanLabel}. Upgrade your plan to add more.`,
      );
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

  private async fetchCount(orgId: string, key: LimitKey): Promise<number> {
    switch (key) {
      case "members": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM organization_members WHERE org_id = ${orgId}`,
        );
        return Number(rows[0]?.["count"] ?? 0);
      }
      case "projects": {
        const rows = await this.db.execute(
          sql`SELECT COUNT(*)::int AS count FROM projects WHERE org_id = ${orgId}`,
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
          sql`SELECT (
            (SELECT COUNT(*) FROM automation_rules WHERE org_id = ${orgId}) +
            (SELECT COUNT(*) FROM project_automations WHERE org_id = ${orgId})
          )::int AS count`,
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
    }
  }
}
