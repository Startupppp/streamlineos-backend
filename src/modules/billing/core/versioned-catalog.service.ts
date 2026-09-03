import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import {
  billingPlans,
  billingPlanEntitlements,
  billingPriceVersions,
  billingProducts,
  orgEntitlementOverrides,
  subscriptionItems,
} from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { isUniqueViolation } from "../../../common/db/postgres-error";

export interface ActivePriceVersion {
  id: number;
  planId: number;
  amountMinor: number;
  currency: string;
  billingInterval: string;
  taxBehavior: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

export interface PlanEntitlementSnapshot {
  featureKey: string;
  limitValue: number | null;
  source: "plan" | "org_override";
}

const ENTITLEMENT_CACHE_TTL = 60;

@Injectable()
export class VersionedCatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getActivePriceForPlan(planId: number, now = new Date()): Promise<ActivePriceVersion | null> {
    const [row] = await this.db
      .select({
        id: billingPriceVersions.id,
        planId: billingPriceVersions.planId,
        amountMinor: billingPriceVersions.amountMinor,
        currency: billingPriceVersions.currency,
        billingInterval: billingPriceVersions.billingInterval,
        taxBehavior: billingPriceVersions.taxBehavior,
        effectiveFrom: billingPriceVersions.effectiveFrom,
        effectiveUntil: billingPriceVersions.effectiveUntil,
      })
      .from(billingPriceVersions)
      .where(
        and(
          eq(billingPriceVersions.planId, planId),
          eq(billingPriceVersions.isActive, true),
          lte(billingPriceVersions.effectiveFrom, now),
          or(
            isNull(billingPriceVersions.effectiveUntil),
            sql`${billingPriceVersions.effectiveUntil} > ${now}`,
          ),
        ),
      )
      .orderBy(billingPriceVersions.effectiveFrom)
      .limit(1);

    return row ?? null;
  }

  /** Bridges the legacy `subscriptions.plan` tier to a commercial price version; null while the catalog is unseeded. */
  async getActivePriceForPlanTier(planTier: string, now = new Date()): Promise<ActivePriceVersion | null> {
    const [row] = await this.db
      .select({
        id: billingPriceVersions.id,
        planId: billingPriceVersions.planId,
        amountMinor: billingPriceVersions.amountMinor,
        currency: billingPriceVersions.currency,
        billingInterval: billingPriceVersions.billingInterval,
        taxBehavior: billingPriceVersions.taxBehavior,
        effectiveFrom: billingPriceVersions.effectiveFrom,
        effectiveUntil: billingPriceVersions.effectiveUntil,
      })
      .from(billingPriceVersions)
      .innerJoin(billingPlans, eq(billingPriceVersions.planId, billingPlans.id))
      .where(
        and(
          eq(billingPlans.planTier, planTier),
          eq(billingPlans.isActive, true),
          eq(billingPriceVersions.isActive, true),
          lte(billingPriceVersions.effectiveFrom, now),
          or(
            isNull(billingPriceVersions.effectiveUntil),
            sql`${billingPriceVersions.effectiveUntil} > ${now}`,
          ),
        ),
      )
      .orderBy(billingPriceVersions.effectiveFrom)
      .limit(1);

    return row ?? null;
  }

  async getPriceVersionById(priceVersionId: number): Promise<ActivePriceVersion | null> {
    const [row] = await this.db
      .select({
        id: billingPriceVersions.id,
        planId: billingPriceVersions.planId,
        amountMinor: billingPriceVersions.amountMinor,
        currency: billingPriceVersions.currency,
        billingInterval: billingPriceVersions.billingInterval,
        taxBehavior: billingPriceVersions.taxBehavior,
        effectiveFrom: billingPriceVersions.effectiveFrom,
        effectiveUntil: billingPriceVersions.effectiveUntil,
      })
      .from(billingPriceVersions)
      .where(eq(billingPriceVersions.id, priceVersionId))
      .limit(1);
    return row ?? null;
  }

  async resolveOrgEntitlements(orgId: string, now = new Date()): Promise<PlanEntitlementSnapshot[]> {
    const cacheKey = `billing:ent-overrides:${orgId}`;
    return this.cache.cached(
      cacheKey,
      () => this.fetchOrgEntitlements(orgId, now),
      ENTITLEMENT_CACHE_TTL,
    );
  }

  private async fetchOrgEntitlements(orgId: string, now: Date): Promise<PlanEntitlementSnapshot[]> {
    const rows = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            featureKey: orgEntitlementOverrides.featureKey,
            limitValue: orgEntitlementOverrides.limitValue,
          })
          .from(orgEntitlementOverrides)
          .where(
            and(
              eq(orgEntitlementOverrides.orgId, orgId),
              lte(orgEntitlementOverrides.effectiveFrom, now),
              or(
                isNull(orgEntitlementOverrides.effectiveUntil),
                sql`${orgEntitlementOverrides.effectiveUntil} > ${now}`,
              ),
            ),
          )
          .orderBy(orgEntitlementOverrides.effectiveFrom),
      { orgId },
    );

    return rows.map((r) => ({
      featureKey: r.featureKey,
      limitValue: r.limitValue,
      source: "org_override" as const,
    }));
  }

  async bustOrgEntitlementCache(orgId: string): Promise<void> {
    await this.cache.invalidate(`billing:ent-overrides:${orgId}`);
  }

  async upsertOrgEntitlementOverride(
    orgId: string,
    featureKey: string,
    limitValue: number | null,
    actorId: string,
    reason: string,
    idempotencyKey?: string,
    tx?: DbOrTx,
  ): Promise<void> {
    const now = new Date();
    const executor = tx ?? this.db;
    try {
      await executor
        .insert(orgEntitlementOverrides)
        .values({
          orgId,
          featureKey,
          limitValue,
          reason,
          actorId,
          idempotencyKey: idempotencyKey ?? null,
          effectiveFrom: now,
          effectiveUntil: null,
        })
        .onConflictDoUpdate({
          target: [orgEntitlementOverrides.orgId, orgEntitlementOverrides.idempotencyKey],
          targetWhere: sql`idempotency_key IS NOT NULL`,
          set: { limitValue, reason, effectiveFrom: now, effectiveUntil: null },
          setWhere: sql`idempotency_key IS NOT NULL`,
        });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictException("Entitlement override already exists for this window");
      throw err;
    }
    const deferred = registerAfterCommit(() => this.bustOrgEntitlementCache(orgId));
    if (!deferred) await this.bustOrgEntitlementCache(orgId);
  }

  async listProducts() {
    return this.db
      .select({
        id: billingProducts.id,
        slug: billingProducts.slug,
        name: billingProducts.name,
        description: billingProducts.description,
        isActive: billingProducts.isActive,
      })
      .from(billingProducts)
      .where(eq(billingProducts.isActive, true))
      .orderBy(billingProducts.id);
  }

  async listPlansByProduct(productId: number) {
    return this.db
      .select({
        id: billingPlans.id,
        slug: billingPlans.slug,
        displayName: billingPlans.displayName,
        planTier: billingPlans.planTier,
        sortOrder: billingPlans.sortOrder,
      })
      .from(billingPlans)
      .where(and(eq(billingPlans.productId, productId), eq(billingPlans.isActive, true)))
      .orderBy(billingPlans.sortOrder);
  }

  async getSubscriptionCurrentPriceVersion(orgId: string, subscriptionId: number): Promise<ActivePriceVersion | null> {
    const now = new Date();
    const [row] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            id: billingPriceVersions.id,
            planId: billingPriceVersions.planId,
            amountMinor: billingPriceVersions.amountMinor,
            currency: billingPriceVersions.currency,
            billingInterval: billingPriceVersions.billingInterval,
            taxBehavior: billingPriceVersions.taxBehavior,
            effectiveFrom: billingPriceVersions.effectiveFrom,
            effectiveUntil: billingPriceVersions.effectiveUntil,
          })
          .from(subscriptionItems)
          .innerJoin(billingPriceVersions, eq(subscriptionItems.priceVersionId, billingPriceVersions.id))
          .where(
            and(
              eq(subscriptionItems.orgId, orgId),
              eq(subscriptionItems.subscriptionId, subscriptionId),
              lte(subscriptionItems.effectiveFrom, now),
              or(
                isNull(subscriptionItems.effectiveUntil),
                sql`${subscriptionItems.effectiveUntil} > ${now}`,
              ),
            ),
          )
          .orderBy(subscriptionItems.effectiveFrom)
          .limit(1),
      { orgId },
    );
    return row ?? null;
  }

  async listPlanEntitlements(planId: number, now = new Date()): Promise<PlanEntitlementSnapshot[]> {
    const rows = await this.db
      .select({
        featureKey: billingPlanEntitlements.featureKey,
        limitValue: billingPlanEntitlements.limitValue,
      })
      .from(billingPlanEntitlements)
      .where(
        and(
          eq(billingPlanEntitlements.planId, planId),
          lte(billingPlanEntitlements.effectiveFrom, now),
          or(
            isNull(billingPlanEntitlements.effectiveUntil),
            sql`${billingPlanEntitlements.effectiveUntil} > ${now}`,
          ),
        ),
      )
      .orderBy(billingPlanEntitlements.featureKey);

    return rows.map((r) => ({
      featureKey: r.featureKey,
      limitValue: r.limitValue,
      source: "plan" as const,
    }));
  }
}
