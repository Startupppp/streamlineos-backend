import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, desc } from "drizzle-orm";
import {
  commissionRules,
  commissions,
  salesQuotas,
  playbookEntries,
  deals,
  users,
  notifications,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  CommissionRuleCreateInput,
  CommissionListInput,
  QuotaListInput,
  QuotaCreateInput,
  PlaybookCreateInput,
  PlaybookUpdateInput,
} from "./dto/sales.schemas";

export type SalesForbidden = { error: "forbidden"; message: string };
export type CommissionNotFound = { error: "not_found" };
export type CommissionConflict = { error: "conflict"; message: string };

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
  ) {}

  listCommissionRules(orgId: string) {
    const key = `sales:commission-rules:${orgId}`;
    return this.cache.cached(
      key,
      () =>
        this.db
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

  async createCommissionRule(orgId: string, input: CommissionRuleCreateInput) {
    const [rule] = await this.db
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

    await this.cache.invalidatePattern(`sales:commission-rules:${orgId}*`);

    return rule;
  }

  listCommissions(orgId: string, filters: CommissionListInput) {
    return this.cache.cached(
      CACHE_KEYS.commissionsList(orgId),
      async () => {
        const conditions = [eq(commissions.orgId, orgId)];
        if (filters.userId) conditions.push(eq(commissions.userId, filters.userId));
        if (filters.status) conditions.push(eq(commissions.status, filters.status));

        const results = await this.db
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

  async updateCommission(orgId: string, commissionId: number, status: "approved" | "paid") {
    const [existing] = await this.db
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

    const [updated] = await this.db
      .update(commissions)
      .set({
        status,
        paidAt: status === "paid" ? new Date() : null,
      })
      .where(and(eq(commissions.id, commissionId), eq(commissions.orgId, orgId)))
      .returning();

    if (!updated) return { error: "not_found" } as CommissionNotFound;

    await this.cache.invalidate(CACHE_KEYS.commissionsList(orgId));

    const [deal] = await this.db
      .select({ name: deals.name })
      .from(deals)
      .where(eq(deals.id, existing.dealId))
      .limit(1);

    await this.db.insert(notifications).values({
      orgId,
      userId: existing.userId,
      type: "SUCCESS",
      title: status === "paid" ? "Commission paid" : "Commission approved",
      message: `Your commission${deal?.name ? ` for ${deal.name}` : ""} of ₹${Number(existing.commissionAmount).toLocaleString("en-IN")} was ${status}.`,
      link: "/sales/commissions",
    });

    return updated;
  }

  listQuotas(orgId: string, filters: QuotaListInput) {
    return this.cache.cached(
      CACHE_KEYS.quotasList(orgId),
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
    actor: { isOrgOwner: boolean; isPlatformAdmin: boolean; permissions: string[] },
    setById: string,
    input: QuotaCreateInput,
  ) {
    if (!actor.isOrgOwner && !actor.isPlatformAdmin && !actor.permissions.includes("crm:targets:manage")) {
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

    await this.cache.invalidate(CACHE_KEYS.quotasList(orgId));
    return quota;
  }

  listPlaybook(orgId: string) {
    return this.db
      .select()
      .from(playbookEntries)
      .where(eq(playbookEntries.orgId, orgId))
      .orderBy(asc(playbookEntries.sortOrder), asc(playbookEntries.id));
  }

  async createPlaybookEntry(orgId: string, createdBy: string, input: PlaybookCreateInput) {
    const [entry] = await this.db
      .insert(playbookEntries)
      .values({
        orgId,
        title: input.title,
        category: input.category?.trim() || null,
        content: input.content ?? "",
        sortOrder: input.sortOrder ?? 0,
        createdBy,
      })
      .returning();

    return entry;
  }

  async updatePlaybookEntry(orgId: string, entryId: number, input: PlaybookUpdateInput) {
    const values: Partial<typeof playbookEntries.$inferInsert> = {};
    if (input.title !== undefined) values.title = input.title;
    if (input.category !== undefined) values.category = input.category?.trim() || null;
    if (input.content !== undefined) values.content = input.content;
    if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;

    const [updated] = await this.db
      .update(playbookEntries)
      .set(values)
      .where(and(eq(playbookEntries.id, entryId), eq(playbookEntries.orgId, orgId)))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async removePlaybookEntry(orgId: string, entryId: number) {
    const [deleted] = await this.db
      .delete(playbookEntries)
      .where(and(eq(playbookEntries.id, entryId), eq(playbookEntries.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }
}
