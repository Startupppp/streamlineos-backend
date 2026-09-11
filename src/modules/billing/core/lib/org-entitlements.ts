import { ConflictException } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import {
  billingPlanEntitlements,
  orgEntitlementOverrides,
} from "../../../../db/schema";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";

export interface PlanEntitlementSnapshot {
  featureKey: string;
  limitValue: number | null;
  source: "plan" | "org_override";
}

const ENTITLEMENT_CACHE_TTL = 60;

/**
 * What an organisation is entitled to, and the overrides that change it.
 *
 * Split from the price catalogue next door because they answer different
 * questions about the same tables: a price version says what a plan COSTS at a
 * moment, and an entitlement says what it ALLOWS. Only the entitlement side is
 * cached and therefore only it has to be busted, which is why
 * `bustOrgEntitlementCache` has no counterpart among the price reads.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface EntitlementDeps {
  readonly db: Db;
  readonly cache: CacheService;
}

export async function resolveOrgEntitlements(
  deps: EntitlementDeps,
  orgId: string,
  now = new Date(),
): Promise<PlanEntitlementSnapshot[]> {
  const cacheKey = `billing:ent-overrides:${orgId}`;
  return deps.cache.cached(
    cacheKey,
    () => fetchOrgEntitlements(deps, orgId, now),
    ENTITLEMENT_CACHE_TTL,
  );
}

async function fetchOrgEntitlements(
  deps: EntitlementDeps,
  orgId: string,
  now: Date,
): Promise<PlanEntitlementSnapshot[]> {
  const rows = await runInTenantTransaction(
    deps.db,
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

export async function bustOrgEntitlementCache(
  deps: EntitlementDeps,
  orgId: string,
): Promise<void> {
  await deps.cache.invalidate(`billing:ent-overrides:${orgId}`);
}

export async function upsertOrgEntitlementOverride(
  deps: EntitlementDeps,
  orgId: string,
  featureKey: string,
  limitValue: number | null,
  actorId: string,
  reason: string,
  idempotencyKey?: string,
  tx?: DbOrTx,
): Promise<void> {
  const now = new Date();
  const executor = tx ?? deps.db;
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
        /**
         * `uq_org_ent_overrides_idem` is partial — `WHERE idempotency_key IS
         * NOT NULL`. PostgreSQL only infers a partial index when the
         * statement repeats its predicate, so without this the arbiter
         * matches nothing and the whole statement is rejected before it
         * runs: "there is no unique or exclusion constraint matching the ON
         * CONFLICT specification". Not a weaker guarantee — no insert at all.
         *
         * `setWhere` below reads like it would serve, and does not: it
         * qualifies the UPDATE, not the conflict target. That near-miss is
         * why this was invisible.
         */
        targetWhere: sql`idempotency_key IS NOT NULL`,
        set: { limitValue, reason, effectiveFrom: now, effectiveUntil: null },
        /**
         * Qualified, because a DO UPDATE ... WHERE has both the stored row
         * and `excluded` in scope, and a bare `idempotency_key` is ambiguous
         * there — PostgreSQL rejects the statement a second time, for a
         * second reason. The ON CONFLICT target above needs no qualification
         * for the opposite reason: only the target table is in scope there.
         */
        setWhere: sql`${orgEntitlementOverrides.idempotencyKey} IS NOT NULL`,
      });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") throw new ConflictException("Entitlement override already exists for this window");
    throw err;
  }
  const deferred = registerAfterCommit(() => bustOrgEntitlementCache(deps, orgId));
  if (!deferred) await bustOrgEntitlementCache(deps, orgId);
}

export async function listPlanEntitlements(
  deps: EntitlementDeps,
  planId: number,
  now = new Date(),
): Promise<PlanEntitlementSnapshot[]> {
  const rows = await deps.db
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
