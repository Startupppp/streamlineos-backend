import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import {
  billingPlans,
  billingPriceVersions,
  billingProducts,
  subscriptionItems,
} from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  bustOrgEntitlementCache,
  listPlanEntitlements,
  resolveOrgEntitlements,
  upsertOrgEntitlementOverride,
  type EntitlementDeps,
} from "./lib/org-entitlements";
import type { PlanEntitlementSnapshot } from "./lib/org-entitlements";

export type { PlanEntitlementSnapshot };

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
            sql`${billingPriceVersions.effectiveUntil} > ${now.toISOString()}::timestamptz`,
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
            sql`${billingPriceVersions.effectiveUntil} > ${now.toISOString()}::timestamptz`,
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

  /** @see lib/org-entitlements.ts */
  async resolveOrgEntitlements(
    orgId: string,
    now = new Date(),
  ): Promise<PlanEntitlementSnapshot[]> {
    return resolveOrgEntitlements(this.entitlementDeps, orgId, now);
  }

  /** @see lib/org-entitlements.ts */
  async bustOrgEntitlementCache(orgId: string): Promise<void> {
    return bustOrgEntitlementCache(this.entitlementDeps, orgId);
  }

  /** @see lib/org-entitlements.ts */
  async listPlanEntitlements(
    planId: number,
    now = new Date(),
  ): Promise<PlanEntitlementSnapshot[]> {
    return listPlanEntitlements(this.entitlementDeps, planId, now);
  }

  /** @see lib/org-entitlements.ts */
  async upsertOrgEntitlementOverride(
    orgId: string,
    featureKey: string,
    limitValue: number | null,
    actorId: string,
    reason: string,
    idempotencyKey?: string,
    tx?: DbOrTx,
  ): Promise<void> {
    return upsertOrgEntitlementOverride(
      this.entitlementDeps,
      orgId,
      featureKey,
      limitValue,
      actorId,
      reason,
      idempotencyKey,
      tx,
    );
  }

  private get entitlementDeps(): EntitlementDeps {
    return { db: this.db, cache: this.cache };
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
                sql`${subscriptionItems.effectiveUntil} > ${now.toISOString()}::timestamptz`,
              ),
            ),
          )
          .orderBy(subscriptionItems.effectiveFrom)
          .limit(1),
      { orgId },
    );
    return row ?? null;
  }

}
