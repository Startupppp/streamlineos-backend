import { and, desc, eq } from "drizzle-orm";
import {
  commissionRules,
  commissions,
  deals,
  users,
  notifications,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  CommissionRuleCreateInput,
  CommissionListInput,
} from "../dto/sales.schemas";

export type CommissionConflict = { error: "conflict"; message: string };

export type CommissionNotFound = { error: "not_found" };

/**
 * Commission rules, and the commissions they produce.
 *
 * Split out of `sales.service.ts`, which held three unrelated subjects behind
 * one class: commissions, quotas and the sales playbook. They share a module
 * and a controller, not a model — nothing here reads a quota and nothing in the
 * playbook reads a commission.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface CommissionDeps {
  readonly db: Db;
  readonly cache: CacheService;
}

export function listCommissionRules(deps: CommissionDeps, orgId: string) {
  return deps.cache.cachedVersioned(
    `sales:commission-rules:${orgId}`,
    "list",
    () =>
      deps.db
        .select({
          id: commissionRules.id,
          name: commissionRules.name,
          type: commissionRules.type,
          flatRate: commissionRules.flatRate,
          tiers: commissionRules.tiers,
          appliesTo: commissionRules.appliesTo,
          createdAt: commissionRules.createdAt,
        })
        .from(commissionRules)
        .where(eq(commissionRules.orgId, orgId))
        .orderBy(desc(commissionRules.createdAt)),
    CACHE_TTL.LONG,
  );
}

export async function createCommissionRule(
  deps: CommissionDeps,
  orgId: string,
  input: CommissionRuleCreateInput,
) {
  const [rule] = await deps.db
    .insert(commissionRules)
    .values({
      orgId,
      name: input.name,
      type: input.type,
      flatRate: input.flatRate ?? null,
      tiers: input.tiers ?? null,
      appliesTo: input.appliesTo,
    })
    .returning();

  await deps.cache.invalidateNamespace(`sales:commission-rules:${orgId}`);

  return rule;
}

export function listCommissions(
  deps: CommissionDeps,
  orgId: string,
  filters: CommissionListInput,
) {
  return deps.cache.cachedVersioned(
    `sales:commissions:${orgId}`,
    `${filters.userId ?? "*"}:${filters.status ?? "*"}:${filters.limit ?? 25}`,
    async () => {
      const conditions = [eq(commissions.orgId, orgId)];
      if (filters.userId) conditions.push(eq(commissions.userId, filters.userId));
      if (filters.status) conditions.push(eq(commissions.status, filters.status));

      const results = await deps.db
        .select({
          id: commissions.id,
          userId: commissions.userId,
          userName: users.name,
          dealId: commissions.dealId,
          dealName: deals.name,
          dealValue: commissions.dealValue,
          commissionRate: commissions.commissionRate,
          commissionAmount: commissions.commissionAmount,
          status: commissions.status,
          paidAt: commissions.paidAt,
          createdAt: commissions.createdAt,
        })
        .from(commissions)
        .leftJoin(users, eq(commissions.userId, users.id))
        .leftJoin(deals, eq(commissions.dealId, deals.id))
        .where(and(...conditions))
        .orderBy(desc(commissions.createdAt))
        .limit(filters.limit ?? 25);

      const totalPending = results
        .filter((c) => c.status === "pending")
        .reduce((s, c) => s + Number(c.commissionAmount), 0);
      const totalPaid = results
        .filter((c) => c.status === "paid")
        .reduce((s, c) => s + Number(c.commissionAmount), 0);
      return { items: results, totalPending, totalPaid };
    },
    CACHE_TTL.MEDIUM,
  );
}

export async function updateCommission(
  deps: CommissionDeps,
  orgId: string,
  commissionId: number,
  status: "approved" | "paid",
) {
  const [existing] = await deps.db
    .select({
      id: commissions.id,
      status: commissions.status,
      userId: commissions.userId,
      dealId: commissions.dealId,
      commissionAmount: commissions.commissionAmount,
    })
    .from(commissions)
    .where(and(eq(commissions.id, commissionId), eq(commissions.orgId, orgId)))
    .limit(1);

  if (!existing) return { error: "not_found" } as CommissionNotFound;
  if (existing.status !== "pending") {
    return { error: "conflict", message: "Only pending commissions can be updated" } as CommissionConflict;
  }

  const [updated] = await deps.db
    .update(commissions)
    .set({
      status,
      paidAt: status === "paid" ? new Date() : null,
    })
    .where(and(eq(commissions.id, commissionId), eq(commissions.orgId, orgId)))
    .returning();

  if (!updated) return { error: "not_found" } as CommissionNotFound;

  await deps.cache.invalidateNamespace(`sales:commissions:${orgId}`);

  const [deal] = await deps.db
    .select({ name: deals.name })
    .from(deals)
    .where(eq(deals.id, existing.dealId))
    .limit(1);

  await deps.db.insert(notifications).values({
    orgId,
    userId: existing.userId,
    type: "SUCCESS",
    title: status === "paid" ? "Commission paid" : "Commission approved",
    message: `Your commission${deal?.name ? ` for ${deal.name}` : ""} of ₹${Number(existing.commissionAmount).toLocaleString("en-IN")} was ${status}.`,
    link: "/sales/commissions",
  });

  return updated;
}
