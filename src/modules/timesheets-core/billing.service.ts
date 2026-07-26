import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  timesheets,
  timesheetExports,
  projects,
} from "../../db/schema";
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
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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
    if (query.projectId) conditions.push(eq(timesheets.projectId, query.projectId));

    const entries = await this.db
      .select({
        id: timesheets.id,
        userId: timesheets.userId,
        projectId: timesheets.projectId,
        ticketId: timesheets.ticketId,
        date: timesheets.date,
        hours: timesheets.hours,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        invoicingStatus: timesheets.invoicingStatus,
      })
      .from(timesheets)
      .where(and(...conditions));

    const projectIds = [...new Set(entries.map((e) => e.projectId).filter((id): id is number => id !== null))];
    const projectRows = projectIds.length > 0
      ? await this.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];

    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));
    const defaultCurrency = await this.rateResolver.getDefaultCurrency(u.orgId);

    // Grouped by project AND currency so amounts in different currencies are
    // never silently summed together.
    const byProjectCurrency = new Map<
      string,
      { projectId: number; hours: number; amount: number; currency: string; count: number; missingRate: boolean }
    >();

    const unratedEntries = entries.filter((entry) => entry.billRate === null);
    const resolvedRates = await this.rateResolver.resolveMany(
      u.orgId,
      unratedEntries.map((entry) => ({
        projectId: entry.projectId,
        userId: entry.userId,
        ticketId: entry.ticketId,
        date: entry.date,
      })),
    );
    const resolvedByEntryId = new Map(unratedEntries.map((entry, i) => [entry.id, resolvedRates[i]]));

    for (const entry of entries) {
      const pid = entry.projectId ?? 0;
      const hours = parseFloat(entry.hours);
      let amount = 0;
      let missingRate = false;
      let currency = entry.currency ?? defaultCurrency;

      if (entry.billRate !== null) {
        amount = round2(hours * parseFloat(entry.billRate));
      } else {
        const resolved = resolvedByEntryId.get(entry.id);
        if (resolved && resolved.billRate !== null) {
          amount = round2(hours * resolved.billRate);
          currency = entry.currency ?? resolved.currency;
        } else {
          missingRate = true;
        }
      }

      const key = `${pid}|${currency}`;
      const existing = byProjectCurrency.get(key);
      if (existing) {
        existing.hours = round2(existing.hours + hours);
        existing.amount = round2(existing.amount + amount);
        existing.count++;
        if (missingRate) existing.missingRate = true;
      } else {
        byProjectCurrency.set(key, {
          projectId: pid,
          hours,
          amount,
          currency,
          count: 1,
          missingRate,
        });
      }
    }

    const groups = [...byProjectCurrency.values()].map((data) => ({
      projectId: data.projectId,
      projectName: projectMap.get(data.projectId) ?? "Unknown Project",
      totalHours: data.hours,
      billableAmount: data.amount,
      currency: data.currency,
      entryCount: data.count,
      missingRate: data.missingRate,
    }));

    const byCurrency = new Map<string, { amount: number; hours: number }>();
    let totalHours = 0;
    for (const g of groups) {
      totalHours = round2(totalHours + g.totalHours);
      const c = byCurrency.get(g.currency);
      if (c) {
        c.amount = round2(c.amount + g.billableAmount);
        c.hours = round2(c.hours + g.totalHours);
      } else {
        byCurrency.set(g.currency, { amount: g.billableAmount, hours: g.totalHours });
      }
    }

    const currencyTotals = [...byCurrency.entries()].map(([currency, v]) => ({
      currency,
      amount: v.amount,
      hours: v.hours,
    }));
    const mixed = currencyTotals.length > 1;

    // Conversion evidence against the org default currency, only when there is
    // something to convert: mixed currencies, or a single non-default currency.
    const needsConversion =
      mixed || (currencyTotals.length === 1 && currencyTotals[0]!.currency !== defaultCurrency);

    let converted: ConvertedTotals | null = null;
    if (needsConversion) {
      const foreignCurrencies = currencyTotals
        .map((c) => c.currency)
        .filter((c) => c !== defaultCurrency);
      const fxRates = await this.fx.getLatestRates(u.orgId, foreignCurrencies, defaultCurrency);
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
      const existing = await this.findExportByIdempotencyKey(u.orgId, input.idempotencyKey);
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

    if (input.projectId) conditions.push(eq(timesheets.projectId, input.projectId));

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

    let exported;
    try {
      [exported] = await this.db
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
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: u.userId,
        })
        .returning({ id: timesheetExports.id });
    } catch (err) {
      const pgCode =
        (err as { code?: string })?.code ??
        ((err as { cause?: { code?: string } })?.cause?.code);
      if (pgCode === "23505" && input.idempotencyKey) {
        const existing = await this.findExportByIdempotencyKey(u.orgId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

    await this.audit.recordWithDb({
      orgId: u.orgId,
      actorUserId: u.userId,
      entityType: "billing",
      entityId: exported!.id.toString(),
      action: "billing.exported",
      after: { entryCount: entries.length, totalHours: round2(totalHours) },
    });

    return {
      exportId: exported!.id,
      entryCount: entries.length,
      totalHours: round2(totalHours),
      totalAmount: round2(totalAmount),
    };
  }

  private async findExportByIdempotencyKey(orgId: string, idempotencyKey: string) {
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

    const snapshotRows = (row.snapshot as { computedAmount?: number }[] | null) ?? [];
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

  async createInvoiceDraft(u: CurrentUserContext, input: CreateInvoiceDraftInput) {
    const conditions = [
      eq(timesheets.orgId, u.orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      eq(timesheets.invoicingStatus, "UNINVOICED"),
      gte(timesheets.date, input.startDate),
      lte(timesheets.date, input.endDate),
    ];

    if (input.projectId) conditions.push(eq(timesheets.projectId, input.projectId));

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

    const [exported] = await this.db
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
        createdBy: u.userId,
      })
      .returning({ id: timesheetExports.id });

    if (entries.length > 0) {
      await this.db
        .update(timesheets)
        .set({ invoicingStatus: "INVOICE_DRAFTED", updatedAt: new Date() })
        .where(and(inArray(timesheets.id, entries.map((e) => e.id)), eq(timesheets.orgId, u.orgId)));
    }

    await this.audit.recordWithDb({
      orgId: u.orgId,
      actorUserId: u.userId,
      entityType: "billing",
      entityId: exported!.id.toString(),
      action: "billing.invoice_drafted",
      after: { entryCount: entries.length, amount: round2(totalAmount) },
    });

    return {
      exportId: exported!.id,
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
}
