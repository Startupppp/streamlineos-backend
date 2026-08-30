import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetExports, projects, organizationMembers } from "../../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { convertAmounts, type ConvertedTotals } from "./lib/fx-convert";
import type {
  UninvoicedQuery,
  ExportBillingInput,
  CreateInvoiceDraftInput,
  RatePreviewQuery,
} from "./dto/billing.schemas";
import type { BillingNarrativeInput } from "./dto/ai.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface BillingNarrativeWorkItem {
  projectName: string;
  date: string;
  hours: string;
  description: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: TimesheetsAuditService,
    private readonly rateResolver: RateResolverService,
    private readonly fx: FxService,
  ) {}

  async getUninvoiced(u: CurrentUserContext, query: UninvoicedQuery) {
    const conditions = [
      eq(timesheets.orgId, u.orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      eq(timesheets.invoicingStatus, "UNINVOICED"),
    ];

    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.projectId)
      conditions.push(eq(timesheets.projectId, query.projectId));

    const aggRows = await this.db
      .select({
        projectId: timesheets.projectId,
        totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        ratedAmount: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.billRate} IS NOT NULL THEN ${timesheets.hours}::numeric * ${timesheets.billRate}::numeric ELSE 0 END), 0)::text`,
        entryCount: sql<number>`COUNT(*)::int`,
        unratedCount: sql<number>`COUNT(CASE WHEN ${timesheets.billRate} IS NULL THEN 1 END)::int`,
        currency: sql<string | null>`MAX(${timesheets.currency})`,
      })
      .from(timesheets)
      .where(and(...conditions))
      .groupBy(timesheets.projectId);

    const unratedEntries = await this.db
      .select({
        id: timesheets.id,
        userId: timesheets.userId,
        projectId: timesheets.projectId,
        ticketId: timesheets.ticketId,
        date: timesheets.date,
        hours: timesheets.hours,
      })
      .from(timesheets)
      .where(and(...conditions, isNull(timesheets.billRate)))
      .limit(500);

    const resolvedRates = await this.rateResolver.resolveMany(
      u.orgId,
      unratedEntries.map((entry) => ({
        projectId: entry.projectId,
        userId: entry.userId,
        ticketId: entry.ticketId,
        date: entry.date,
      })),
    );

    const extraAmountByProject = new Map<number, number>();
    const resolvedUnratedByProject = new Map<number, number>();
    unratedEntries.forEach((entry, i) => {
      const resolved = resolvedRates[i];
      if (resolved && resolved.billRate !== null) {
        const pid = entry.projectId ?? 0;
        extraAmountByProject.set(
          pid,
          (extraAmountByProject.get(pid) ?? 0) +
            parseFloat(entry.hours) * resolved.billRate,
        );
        resolvedUnratedByProject.set(
          pid,
          (resolvedUnratedByProject.get(pid) ?? 0) + 1,
        );
      }
    });

    const projectIds = aggRows
      .map((r) => r.projectId)
      .filter((id): id is number => id !== null);
    const projectRows =
      projectIds.length > 0
        ? await this.db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)))
        : [];
    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));

    const groups = aggRows.map((r) => {
      const pid = r.projectId ?? 0;
      const extraAmount = extraAmountByProject.get(pid) ?? 0;
      const stillUnrated =
        r.unratedCount - (resolvedUnratedByProject.get(pid) ?? 0);
      return {
        projectId: pid,
        projectName: projectMap.get(pid) ?? "Unknown Project",
        totalHours: round2(parseFloat(r.totalHours)),
        billableAmount: round2(parseFloat(r.ratedAmount) + extraAmount),
        currency: r.currency ?? "USD",
        entryCount: r.entryCount,
        missingRate: stillUnrated > 0,
      };
    });

    const byCurrency = new Map<string, { amount: number; hours: number }>();
    let totalHours = 0;
    for (const g of groups) {
      totalHours = round2(totalHours + g.totalHours);
      const c = byCurrency.get(g.currency);
      if (c) {
        c.amount = round2(c.amount + g.billableAmount);
        c.hours = round2(c.hours + g.totalHours);
      } else {
        byCurrency.set(g.currency, {
          amount: g.billableAmount,
          hours: g.totalHours,
        });
      }
    }

    const defaultCurrency = await this.rateResolver.getDefaultCurrency(u.orgId);

    const currencyTotals = [...byCurrency.entries()].map(([currency, v]) => ({
      currency,
      amount: v.amount,
      hours: v.hours,
    }));
    const mixed = currencyTotals.length > 1;

    // Conversion evidence against the org default currency, only when there is
    // something to convert: mixed currencies, or a single non-default currency.
    const needsConversion =
      mixed ||
      (currencyTotals.length === 1 &&
        currencyTotals[0]!.currency !== defaultCurrency);

    let converted: ConvertedTotals | null = null;
    if (needsConversion) {
      const foreignCurrencies = currencyTotals
        .map((c) => c.currency)
        .filter((c) => c !== defaultCurrency);
      const fxRates = await this.fx.getLatestRates(
        u.orgId,
        foreignCurrencies,
        defaultCurrency,
      );
      converted = convertAmounts(
        currencyTotals.map((c) => ({ currency: c.currency, amount: c.amount })),
        defaultCurrency,
        fxRates,
      );
    }

    const totals = {
      hours: totalHours,
      // Only meaningful when a single currency is present; null when mixed so
      // callers can never display a cross-currency sum as one number.
      amount: mixed ? null : (currencyTotals[0]?.amount ?? 0),
      currency: mixed ? null : (currencyTotals[0]?.currency ?? defaultCurrency),
      mixed,
      byCurrency: currencyTotals,
      converted,
    };

    return { groups, totals };
  }

  async exportBilling(u: CurrentUserContext, input: ExportBillingInput) {
    if (input.idempotencyKey) {
      const existing = await this.findExportByIdempotencyKey(
        u.orgId,
        input.idempotencyKey,
      );
      if (existing) return existing;
    }

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      gte(timesheets.date, input.startDate),
      lte(timesheets.date, input.endDate),
    ];

    if (input.projectId)
      conditions.push(eq(timesheets.projectId, input.projectId));

    const entries = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        projectId: timesheets.projectId,
        ticketId: timesheets.ticketId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        invoicingStatus: timesheets.invoicingStatus,
        status: timesheets.status,
      })
      .from(timesheets)
      .where(and(...conditions));

    let totalHours = 0;
    let totalAmount = 0;

    const snapshot = entries.map((e) => {
      const hours = parseFloat(e.hours);
      const rate = e.billRate ? parseFloat(e.billRate) : 0;
      const amount = round2(hours * rate);
      totalHours += hours;
      totalAmount += amount;
      return { ...e, computedAmount: amount };
    });

    const exportId = await this.db.transaction(async (tx) => {
      const [actorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
        .limit(1);

      const [exported] = await tx
        .insert(timesheetExports)
        .values({
          orgId: u.orgId,
          exportType: "BILLING",
          status: "COMPLETED",
          dateRangeStart: input.startDate,
          dateRangeEnd: input.endDate,
          format: input.format,
          filters: { projectId: input.projectId ?? null },
          snapshot: snapshot,
          entryCount: entries.length,
          totalHours: round2(totalHours).toString(),
          createdByMembershipId: actorMember?.id ?? null,
        })
        .returning({ id: timesheetExports.id });

      if (!exported)
        throw new InternalServerErrorException(
          "Failed to create billing export",
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "billing",
        entityId: exported.id.toString(),
        action: "billing.exported",
        after: { entryCount: entries.length, totalHours: round2(totalHours) },
      });

      return exported.id;
    });

    return {
      exportId,
      entryCount: entries.length,
      totalHours: round2(totalHours),
      totalAmount: round2(totalAmount),
    };
  }

  private async findExportByIdempotencyKey(
    orgId: string,
    idempotencyKey: string,
  ) {
    const [row] = await this.db
      .select({
        id: timesheetExports.id,
        entryCount: timesheetExports.entryCount,
        totalHours: timesheetExports.totalHours,
        snapshot: timesheetExports.snapshot,
      })
      .from(timesheetExports)
      .where(
        and(
          eq(timesheetExports.orgId, orgId),
          eq(timesheetExports.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!row) return null;

    const snapshotRows =
      (row.snapshot as { computedAmount?: number }[] | null) ?? [];
    const totalAmount = round2(
      snapshotRows.reduce((sum, r) => sum + (r.computedAmount ?? 0), 0),
    );

    return {
      exportId: row.id,
      entryCount: row.entryCount,
      totalHours: parseFloat(row.totalHours),
      totalAmount,
      duplicate: true,
    };
  }

  async createInvoiceDraft(
    u: CurrentUserContext,
    input: CreateInvoiceDraftInput,
  ) {
    const conditions = [
      eq(timesheets.orgId, u.orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      eq(timesheets.invoicingStatus, "UNINVOICED"),
      gte(timesheets.date, input.startDate),
      lte(timesheets.date, input.endDate),
    ];

    if (input.projectId)
      conditions.push(eq(timesheets.projectId, input.projectId));

    const entries = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        projectId: timesheets.projectId,
        ticketId: timesheets.ticketId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        invoicingStatus: timesheets.invoicingStatus,
        status: timesheets.status,
      })
      .from(timesheets)
      .where(and(...conditions));

    let totalAmount = 0;
    const snapshot = entries.map((e) => {
      const hours = parseFloat(e.hours);
      const rate = e.billRate ? parseFloat(e.billRate) : 0;
      const amount = round2(hours * rate);
      totalAmount += amount;
      return { ...e, computedAmount: amount };
    });

    const entryIds = entries.map((e) => e.id);

    const exportId = await this.db.transaction(async (tx) => {
      const [draftActorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
        .limit(1);

      const [exported] = await tx
        .insert(timesheetExports)
        .values({
          orgId: u.orgId,
          exportType: "INVOICE_DRAFT",
          status: "COMPLETED",
          dateRangeStart: input.startDate,
          dateRangeEnd: input.endDate,
          format: "JSON",
          filters: { projectId: input.projectId ?? null },
          snapshot: snapshot,
          entryCount: entries.length,
          totalHours: "0",
          createdByMembershipId: draftActorMember?.id ?? null,
        })
        .returning({ id: timesheetExports.id });

      if (!exported)
        throw new InternalServerErrorException(
          "Failed to create invoice draft",
        );

      if (entryIds.length > 0) {
        await tx
          .update(timesheets)
          .set({ invoicingStatus: "INVOICE_DRAFTED", updatedAt: new Date() })
          .where(
            and(
              inArray(timesheets.id, entryIds),
              eq(timesheets.orgId, u.orgId),
            ),
          );
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "billing",
        entityId: exported.id.toString(),
        action: "billing.invoice_drafted",
        after: { entryCount: entries.length, amount: round2(totalAmount) },
      });

      return exported.id;
    });

    return {
      exportId,
      entryCount: entries.length,
      amount: round2(totalAmount),
    };
  }

  async getRatePreview(u: CurrentUserContext, query: RatePreviewQuery) {
    const resolved = await this.rateResolver.resolve(u.orgId, {
      projectId: query.projectId,
      userId: query.userId,
      ticketId: query.ticketId,
    });
    return resolved;
  }

  async getBillableWorkForNarrative(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
  ): Promise<BillingNarrativeWorkItem[]> {
    const conditions = [
      eq(timesheets.orgId, u.orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      eq(timesheets.invoicingStatus, "UNINVOICED"),
      gte(timesheets.date, input.startDate),
      lte(timesheets.date, input.endDate),
    ];
    if (input.projectId)
      conditions.push(eq(timesheets.projectId, input.projectId));

    const rows = await this.db
      .select({
        projectName: projects.name,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
      })
      .from(timesheets)
      .leftJoin(projects, eq(timesheets.projectId, projects.id))
      .where(and(...conditions))
      .orderBy(timesheets.date)
      .limit(200);

    return rows.map((r) => ({
      projectName: r.projectName ?? "Unassigned",
      date: r.date,
      hours: r.hours,
      description: r.description,
    }));
  }
}
