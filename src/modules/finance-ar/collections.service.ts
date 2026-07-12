import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { invoices, finCollectionActivities, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import type { ListCollectionActivitiesQuery, CreateCollectionActivityInput, UpdateInvoiceCollectionInput } from "./dto/finance-ar.schemas";

interface AgingBucket {
  label: string;
  count: number;
  amount: number;
}

interface CustomerRisk {
  clientId: number | null;
  overdueAmount: number;
  totalInvoiced: number;
  maxDaysOverdue: number;
  riskScore: number;
}

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async summary(orgId: string) {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);

    const openInvoices = await this.db
      .select({ id: invoices.id, clientId: invoices.clientId, total: invoices.total, amountPaid: invoices.amountPaid, dueDate: invoices.dueDate, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["ISSUED", "PARTIALLY_PAID", "OVERDUE"])));

    const buckets: AgingBucket[] = [
      { label: "current", count: 0, amount: 0 },
      { label: "1-30", count: 0, amount: 0 },
      { label: "31-60", count: 0, amount: 0 },
      { label: "61-90", count: 0, amount: 0 },
      { label: "91+", count: 0, amount: 0 },
    ];

    const clientMap = new Map<number, { overdueAmount: number; totalInvoiced: number; maxDaysOverdue: number }>();

    for (const inv of openInvoices) {
      const outstanding = Number(inv.total ?? 0) - Number(inv.amountPaid ?? 0);
      const clientId = inv.clientId ?? 0;

      const existing = clientMap.get(clientId) ?? { overdueAmount: 0, totalInvoiced: 0, maxDaysOverdue: 0 };
      existing.totalInvoiced += Number(inv.total ?? 0);

      if (!inv.dueDate) {
        buckets[0]!.count++;
        buckets[0]!.amount += outstanding;
        clientMap.set(clientId, existing);
        continue;
      }

      const dueMs = new Date(`${inv.dueDate}T00:00:00Z`).getTime();
      const daysOverdue = Math.floor((today.getTime() - dueMs) / 86400000);

      if (daysOverdue <= 0) {
        buckets[0]!.count++;
        buckets[0]!.amount += outstanding;
      } else {
        existing.overdueAmount += outstanding;
        existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, daysOverdue);
        if (daysOverdue <= 30) { buckets[1]!.count++; buckets[1]!.amount += outstanding; }
        else if (daysOverdue <= 60) { buckets[2]!.count++; buckets[2]!.amount += outstanding; }
        else if (daysOverdue <= 90) { buckets[3]!.count++; buckets[3]!.amount += outstanding; }
        else { buckets[4]!.count++; buckets[4]!.amount += outstanding; }
      }
      clientMap.set(clientId, existing);
    }

    const topRisk: CustomerRisk[] = Array.from(clientMap.entries())
      .map(([clientId, data]) => {
        const ratio = data.totalInvoiced > 0 ? data.overdueAmount / data.totalInvoiced : 0;
        const riskScore = Math.round(ratio * 50 + Math.min(data.maxDaysOverdue, 180) / 180 * 50);
        return { clientId: clientId || null, overdueAmount: data.overdueAmount, totalInvoiced: data.totalInvoiced, maxDaysOverdue: data.maxDaysOverdue, riskScore };
      })
      .filter((r) => r.overdueAmount > 0)
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10);

    return { agingBuckets: buckets, topRiskCustomers: topRisk, asOf: todayIso };
  }

  async listActivities(orgId: string, query: ListCollectionActivitiesQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(finCollectionActivities.orgId, orgId)];
    if (query.clientId) conditions.push(eq(finCollectionActivities.clientId, query.clientId));
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(finCollectionActivities).where(and(...conditions)).orderBy(desc(finCollectionActivities.createdAt)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finCollectionActivities).where(and(...conditions)),
    ]);
    return buildListResponse(rows, count, query);
  }

  async createActivity(orgId: string, userId: string, input: CreateCollectionActivityInput) {
    const [activity] = await this.db
      .insert(finCollectionActivities)
      .values({
        orgId,
        clientId: input.clientId,
        invoiceId: input.invoiceId ?? null,
        type: input.type,
        note: input.note ?? null,
        promisedDate: input.promisedDate ?? null,
        createdBy: userId,
      })
      .returning();
    if (!activity) throw new Error("Activity insert returned no rows");
    this.audit.log({ action: "collection_activity.create", userId, orgId, resourceType: "collection_activity", resourceId: String(activity.id) });
    return activity;
  }

  async updateInvoiceCollection(orgId: string, userId: string, invoiceId: number, input: UpdateInvoiceCollectionInput) {
    const inv = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
      columns: { id: true },
    });
    if (!inv) throw new NotFoundException("Invoice not found");

    if (input.collectionOwnerId) {
      const member = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, input.collectionOwnerId), eq(organizationMembers.orgId, orgId)))
        .limit(1);
      if (member.length === 0) throw new BadRequestException("Collection owner must be an organization member");
    }

    await this.db
      .update(invoices)
      .set({
        ...(input.collectionOwnerId !== undefined ? { collectionOwnerId: input.collectionOwnerId } : {}),
        ...(input.promiseToPayDate !== undefined ? { promiseToPayDate: input.promiseToPayDate } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));

    this.audit.log({ action: "invoice.collection_update", userId, orgId, resourceType: "invoice", resourceId: String(invoiceId) });
    return { success: true };
  }
}
