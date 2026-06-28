import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { incentives, incentiveConfig, incentiveStatusEnum, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ApproveIncentiveInput, IncentivesQueryInput } from "./dto/payroll.schemas";

type IncentiveStatus = (typeof incentiveStatusEnum.enumValues)[number];

function isIncentiveStatus(value: string): value is IncentiveStatus {
  return (incentiveStatusEnum.enumValues as readonly string[]).includes(value);
}

@Injectable()
export class IncentivesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getIncentives(orgId: string, params: IncentivesQueryInput) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(incentives.orgId, orgId)];
    if (params.status && isIncentiveStatus(params.status)) {
      conditions.push(eq(incentives.status, params.status));
    }

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(incentives)
      .where(and(...conditions));

    const total = Number(countResult?.count || 0);

    const rows = await this.db
      .select({
        id: incentives.id,
        orgId: incentives.orgId,
        salesRepId: incentives.salesRepId,
        clientAccountId: incentives.clientAccountId,
        investmentAmount: incentives.investmentAmount,
        incentiveRate: incentives.incentiveRate,
        calculatedAmount: incentives.calculatedAmount,
        approvedAmount: incentives.approvedAmount,
        status: incentives.status,
        notes: incentives.notes,
        createdAt: incentives.createdAt,
        salesRepName: users.name,
        salesRepImage: users.image,
      })
      .from(incentives)
      .innerJoin(users, eq(incentives.salesRepId, users.id))
      .where(and(...conditions))
      .orderBy(desc(incentives.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      incentives: rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        salesRepId: r.salesRepId,
        clientAccountId: r.clientAccountId,
        investmentAmount: r.investmentAmount,
        incentiveRate: r.incentiveRate,
        calculatedAmount: r.calculatedAmount,
        approvedAmount: r.approvedAmount,
        status: r.status,
        notes: r.notes,
        createdAt: r.createdAt,
        salesRep: { id: r.salesRepId, name: r.salesRepName, image: r.salesRepImage },
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getIncentiveStats(orgId: string) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const [allRows, monthRows] = await Promise.all([
      this.db.query.incentives.findMany({ where: eq(incentives.orgId, orgId), limit: 10000 }),
      this.db.query.incentives.findMany({
        where: and(eq(incentives.orgId, orgId), gte(incentives.createdAt, new Date(monthStart))),
        limit: 10000,
      }),
    ]);

    let totalRevenue = 0;
    let approved = 0;
    let pending = 0;
    let thisMonth = 0;

    for (const inc of allRows) {
      const amount = Number(inc.calculatedAmount || 0);
      totalRevenue += amount;
      if (inc.status === "APPROVED" || inc.status === "ADDED_TO_PAYROLL") approved++;
      if (inc.status === "PENDING") pending++;
    }
    for (const inc of monthRows) {
      thisMonth += Number(inc.calculatedAmount || 0);
    }

    return {
      thisMonth: thisMonth.toFixed(2),
      totalRevenue: totalRevenue.toFixed(2),
      avgPerConversion: approved > 0 ? (totalRevenue / approved).toFixed(2) : "0.00",
      pending,
      approved,
    };
  }

  getIncentiveConfigs(orgId: string) {
    return this.db
      .select({
        id: incentiveConfig.id,
        orgId: incentiveConfig.orgId,
        incentiveRate: incentiveConfig.incentiveRate,
        effectiveFrom: incentiveConfig.effectiveFrom,
        createdAt: incentiveConfig.createdAt,
        createdByName: users.name,
      })
      .from(incentiveConfig)
      .leftJoin(users, eq(incentiveConfig.createdBy, users.id))
      .where(and(eq(incentiveConfig.orgId, orgId), eq(incentiveConfig.isActive, true)))
      .orderBy(desc(incentiveConfig.effectiveFrom))
      .limit(100);
  }

  async createConfig(orgId: string, userId: string, incentiveRate: string) {
    const [config] = await this.db
      .insert(incentiveConfig)
      .values({ orgId, incentiveRate, createdBy: userId, isActive: true })
      .returning();
    return config;
  }

  async approveIncentive(orgId: string, userId: string, incentiveId: number, body: ApproveIncentiveInput): Promise<{ ok: boolean }> {
    const existing = await this.db.query.incentives.findFirst({
      where: and(eq(incentives.id, incentiveId), eq(incentives.orgId, orgId)),
    });
    if (!existing) return { ok: false };

    await this.db
      .update(incentives)
      .set({
        status: "APPROVED",
        approvedAmount: body.approvedAmount,
        approvedBy: userId,
        approvedAt: new Date(),
        notes: body.notes ?? existing.notes,
      })
      .where(eq(incentives.id, incentiveId));

    return { ok: true };
  }

  async rejectIncentive(orgId: string, incentiveId: number): Promise<{ ok: boolean }> {
    const existing = await this.db.query.incentives.findFirst({
      where: and(eq(incentives.id, incentiveId), eq(incentives.orgId, orgId)),
    });
    if (!existing) return { ok: false };

    await this.db.update(incentives).set({ status: "REJECTED" }).where(eq(incentives.id, incentiveId));
    return { ok: true };
  }
}
