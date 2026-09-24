import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, projects, organizationMembers } from "../../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { convertAmounts, type ConvertedTotals } from "./lib/fx-convert";
import {
  createInvoiceDraft,
  exportBilling,
  releaseInvoiceDraft,
  type BillingExportDeps,
} from "./lib/billing-export";
import { round2 } from "./lib/billing-money";
import type {
  UninvoicedQuery,
  ExportBillingInput,
  CreateInvoiceDraftInput,
  ReleaseInvoiceDraftInput,
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
        currency: timesheets.currency,
      })
      .from(timesheets)
      .where(and(...conditions))
      .groupBy(timesheets.projectId, timesheets.currency);

    const unratedEntries = await this.db
      .select({
        id: timesheets.id,
        userMembershipId: timesheets.userMembershipId,
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
        userMembershipId: entry.userMembershipId,
        ticketId: entry.ticketId,
        date: entry.date,
      })),
    );

    const bucketKey = (projectId: number, currency: string) => `${projectId}\u0000${currency}`;
    const resolvedExtra = new Map<
      string,
      { projectId: number; currency: string; amount: number; hours: number; entryCount: number }
    >();
    const resolvedFromNull = new Map<number, { hours: number; entryCount: number }>();

    unratedEntries.forEach((entry, i) => {
      const resolved = resolvedRates[i];
      if (!resolved || resolved.billRate === null) return;
      const pid = entry.projectId ?? 0;
      const hours = parseFloat(entry.hours);
      const key = bucketKey(pid, resolved.currency);
      const bucket = resolvedExtra.get(key) ?? {
        projectId: pid,
        currency: resolved.currency,
        amount: 0,
        hours: 0,
        entryCount: 0,
      };
      bucket.amount += hours * resolved.billRate;
      bucket.hours += hours;
      bucket.entryCount += 1;
      resolvedExtra.set(key, bucket);

      const drained = resolvedFromNull.get(pid) ?? { hours: 0, entryCount: 0 };
      drained.hours += hours;
      drained.entryCount += 1;
      resolvedFromNull.set(pid, drained);
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

    const defaultCurrency = await this.rateResolver.getDefaultCurrency(u.orgId);

    const buckets = new Map<
      string,
      {
        projectId: number;
        currency: string;
        hours: number;
        amount: number;
        entryCount: number;
        missingRate: boolean;
      }
    >();

    const bucketFor = (projectId: number, currency: string) => {
      const key = bucketKey(projectId, currency);
      const existing = buckets.get(key);
      if (existing) return existing;
      const created = {
        projectId,
        currency,
        hours: 0,
        amount: 0,
        entryCount: 0,
        missingRate: false,
      };
      buckets.set(key, created);
      return created;
    };

    for (const r of aggRows) {
      const pid = r.projectId ?? 0;
      const hours = parseFloat(r.totalHours);

      if (r.currency !== null) {
        const bucket = bucketFor(pid, r.currency);
        bucket.hours += hours;
        bucket.amount += parseFloat(r.ratedAmount);
        bucket.entryCount += r.entryCount;
        if (r.unratedCount > 0) bucket.missingRate = true;
        continue;
      }

      const drained = resolvedFromNull.get(pid) ?? { hours: 0, entryCount: 0 };
      const leftoverHours = hours - drained.hours;
      const leftoverCount = r.entryCount - drained.entryCount;
      if (leftoverHours <= 0 && leftoverCount <= 0) continue;

      const bucket = bucketFor(pid, defaultCurrency);
      bucket.hours += leftoverHours;
      bucket.entryCount += leftoverCount;
      bucket.missingRate = true;
    }

    for (const extra of resolvedExtra.values()) {
      const bucket = bucketFor(extra.projectId, extra.currency);
      bucket.hours += extra.hours;
      bucket.amount += extra.amount;
      bucket.entryCount += extra.entryCount;
    }

    const groups = [...buckets.values()]
      .map((b) => ({
        projectId: b.projectId,
        projectName: projectMap.get(b.projectId) ?? "Unknown Project",
        totalHours: round2(b.hours),
        billableAmount: round2(b.amount),
        currency: b.currency,
        entryCount: b.entryCount,
        missingRate: b.missingRate,
      }))
      .sort((a, b) =>
        a.projectId === b.projectId
          ? a.currency.localeCompare(b.currency)
          : a.projectId - b.projectId,
      );

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

    const currencyTotals = [...byCurrency.entries()].map(([currency, v]) => ({
      currency,
      amount: v.amount,
      hours: v.hours,
    }));
    const mixed = currencyTotals.length > 1;

    const needsConversion =
      mixed ||
      (currencyTotals.length === 1 &&
        currencyTotals[0].currency !== defaultCurrency);

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
      amount: mixed ? null : (currencyTotals[0]?.amount ?? 0),
      currency: mixed ? null : (currencyTotals[0]?.currency ?? defaultCurrency),
      mixed,
      byCurrency: currencyTotals,
      converted,
    };

    return { groups, totals };
  }

  exportBilling(u: CurrentUserContext, input: ExportBillingInput) {
    return exportBilling(this.exportDeps, u, input);
  }

  createInvoiceDraft(u: CurrentUserContext, input: CreateInvoiceDraftInput) {
    return createInvoiceDraft(this.exportDeps, u, input);
  }

  releaseInvoiceDraft(u: CurrentUserContext, input: ReleaseInvoiceDraftInput) {
    return releaseInvoiceDraft(this.exportDeps, u, input);
  }

  private get exportDeps(): BillingExportDeps {
    return { db: this.db, audit: this.audit };
  }

  async getRatePreview(u: CurrentUserContext, query: RatePreviewQuery, subjectUserId: string | undefined) {
    let userMembershipId: number | undefined;
    if (subjectUserId) {
      const [member] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            eq(organizationMembers.userId, subjectUserId),
          ),
        )
        .limit(1);
      userMembershipId = member?.id;
    }
    const resolved = await this.rateResolver.resolve(u.orgId, {
      projectId: query.projectId,
      userMembershipId,
      ticketId: query.ticketId,
      clientId: query.clientId,
      date: query.date,
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
