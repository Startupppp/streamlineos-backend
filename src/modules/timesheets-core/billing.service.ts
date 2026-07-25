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

    const byProject = new Map<
      number,
      { hours: number; amount: number; currency: string; count: number; missingRate: boolean }
    >();

    const unratedEntries = entries.filter((entry) => entry.billRate === null);
    const resolvedRates = await this.rateResolver.resolveMany(
      u.orgId,
      unratedEntries.map((entry) => ({
        projectId: entry.projectId,
        userId: entry.userId,
        ticketId: entry.ticketId,
      })),
    );
    const resolvedByEntryId = new Map(unratedEntries.map((entry, i) => [entry.id, resolvedRates[i]]));

    for (const entry of entries) {
      const pid = entry.projectId ?? 0;
      const hours = parseFloat(entry.hours);
      let amount = 0;
      let missingRate = false;

      if (entry.billRate !== null) {
        amount = round2(hours * parseFloat(entry.billRate));
      } else {
        const resolved = resolvedByEntryId.get(entry.id);
        if (resolved && resolved.billRate !== null) {
          amount = round2(hours * resolved.billRate);
        } else {
          missingRate = true;
        }
      }

      const existing = byProject.get(pid);
      if (existing) {
        existing.hours = round2(existing.hours + hours);
        existing.amount = round2(existing.amount + amount);
        existing.count++;
        if (missingRate) existing.missingRate = true;
      } else {
        byProject.set(pid, {
          hours,
          amount,
          currency: entry.currency ?? "USD",
          count: 1,
          missingRate,
        });
      }
    }

    const groups = [...byProject.entries()].map(([projectId, data]) => ({
      projectId,
      projectName: projectMap.get(projectId) ?? "Unknown Project",
      totalHours: data.hours,
      billableAmount: data.amount,
      currency: data.currency,
      entryCount: data.count,
      missingRate: data.missingRate,
    }));

    const totals = groups.reduce(
      (acc, g) => ({
        hours: round2(acc.hours + g.totalHours),
        amount: round2(acc.amount + g.billableAmount),
        currency: g.currency,
      }),
      { hours: 0, amount: 0, currency: "USD" },
    );

    return { groups, totals };
  }

  async exportBilling(u: CurrentUserContext, input: ExportBillingInput) {
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

    const [exported] = await this.db
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
        createdBy: u.userId,
      })
      .returning({ id: timesheetExports.id });

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
