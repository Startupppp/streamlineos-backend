import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  incentives,
  incentiveConfig,
  incentiveStatusEnum,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { divideDecimals, roundDecimal, toDecimal } from "../../accounting/core/money.util";
import type {
  ApproveIncentiveInput,
  IncentivesQueryInput,
} from "./dto/payroll.schemas";
import { buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import {
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

type IncentiveStatus = (typeof incentiveStatusEnum.enumValues)[number];

function isIncentiveStatus(value: string): value is IncentiveStatus {
  return (incentiveStatusEnum.enumValues as readonly string[]).includes(value);
}

@Injectable()
export class IncentivesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getIncentives(orgId: string, params: IncentivesQueryInput) {
    const limit = Math.min(params.limit ?? 20, 100);
    const status = params.status && isIncentiveStatus(params.status) ? params.status : null;
    const cursorScope = ["incentives", orgId, status] as const;
    const position = decodePayrollTimestampCursor(params.cursor, cursorScope);

    const conditions = [eq(incentives.orgId, orgId)];
    if (status) {
      conditions.push(eq(incentives.status, status));
    }
    if (position) {
      conditions.push(
        keysetBeforeId(incentives.createdAt, incentives.id, {
          sortValue: position.createdAt,
          id: String(position.id),
        }),
      );
    }

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
      .orderBy(desc(incentives.createdAt), desc(incentives.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) =>
      payrollCursorPosition(cursorScope, [row.createdAt.toISOString()], row.id),
    );

    return {
      incentives: page.data.map((r) => ({
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
        salesRep: {
          id: r.salesRepId,
          name: r.salesRepName,
          image: r.salesRepImage,
        },
      })),
      pagination: page.pagination,
    };
  }

  async getIncentiveStats(orgId: string) {
    const now = new Date();
    const monthStart = new Date(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`,
    );

    const [stats] = await this.db
      .select({
        totalRevenue: sql<string>`COALESCE(SUM(${incentives.calculatedAmount}), '0')`,
        approvedCount: sql<string>`COUNT(*) FILTER (WHERE ${incentives.status} IN ('APPROVED', 'ADDED_TO_PAYROLL'))`,
        pendingCount: sql<string>`COUNT(*) FILTER (WHERE ${incentives.status} = 'PENDING')`,
        thisMonth: sql<string>`COALESCE(SUM(CASE WHEN ${incentives.createdAt} >= ${monthStart} THEN ${incentives.calculatedAmount} ELSE 0 END), '0')`,
      })
      .from(incentives)
      .where(eq(incentives.orgId, orgId));

    const totalRevenue = toDecimal(stats?.totalRevenue);
    const approved = Number(stats?.approvedCount ?? 0);
    const pending = Number(stats?.pendingCount ?? 0);
    const thisMonth = toDecimal(stats?.thisMonth);

    return {
      thisMonth: roundDecimal(thisMonth, 2),
      totalRevenue: roundDecimal(totalRevenue, 2),
      avgPerConversion:
        approved > 0 ? roundDecimal(divideDecimals(totalRevenue, String(approved)), 2) : "0.00",
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
      .where(
        and(
          eq(incentiveConfig.orgId, orgId),
          eq(incentiveConfig.isActive, true),
        ),
      )
      .orderBy(desc(incentiveConfig.effectiveFrom))
      .limit(100);
  }

  async createConfig(actor: CurrentUserContext, incentiveRate: string) {
    await this.assertCanApprove(actor);
    const [config] = await this.db
      .insert(incentiveConfig)
      .values({
        orgId: actor.orgId,
        incentiveRate,
        createdBy: actor.userId,
        isActive: true,
      })
      .returning();
    return config;
  }

  async approveIncentive(
    actor: CurrentUserContext,
    incentiveId: number,
    body: ApproveIncentiveInput,
  ): Promise<{ ok: boolean }> {
    await this.assertCanApprove(actor);
    const existing = await this.db.query.incentives.findFirst({
      where: and(
        eq(incentives.id, incentiveId),
        eq(incentives.orgId, actor.orgId),
      ),
    });
    if (!existing) return { ok: false };

    await this.db
      .update(incentives)
      .set({
        status: "APPROVED",
        approvedAmount: body.approvedAmount,
        approvedBy: actor.userId,
        approvedAt: new Date(),
        notes: body.notes ?? existing.notes,
      })
      .where(
        and(eq(incentives.id, incentiveId), eq(incentives.orgId, actor.orgId)),
      );

    return { ok: true };
  }

  async rejectIncentive(
    actor: CurrentUserContext,
    incentiveId: number,
  ): Promise<{ ok: boolean }> {
    await this.assertCanApprove(actor);
    const existing = await this.db.query.incentives.findFirst({
      where: and(
        eq(incentives.id, incentiveId),
        eq(incentives.orgId, actor.orgId),
      ),
    });
    if (!existing) return { ok: false };

    await this.db
      .update(incentives)
      .set({ status: "REJECTED" })
      .where(
        and(eq(incentives.id, incentiveId), eq(incentives.orgId, actor.orgId)),
      );
    return { ok: true };
  }

  private async assertCanApprove(actor: CurrentUserContext): Promise<void> {
    if (actor.isOrgOwner) return;
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    if (!permissions.has("hr:payroll:approve")) {
      throw new ForbiddenException("Missing permission hr:payroll:approve");
    }
  }
}
