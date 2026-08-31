import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { clientAccounts, crmQuoteSettings, deals, quoteLineItems, quotes, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CreateInput, ExportInput, ListInput, UpdateInput } from "./dto/quote.schemas";
import { QuotesLifecycleService } from "./quotes-lifecycle.service";

export { isSendNotDraft } from "./quotes-lifecycle.service";

const LIST_TTL = 30;

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

@Injectable()
export class QuotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly lifecycle: QuotesLifecycleService,
  ) {}

  async list(orgId: string, filters: ListInput) {
    const { status, dealId, search, cursor, pageSize } = filters;
    const limit = pageSize;

    const key = `${status ?? ""}:${dealId ?? ""}:${search ?? ""}:${limit}:${cursor ?? ""}`;
    return this.cache.cachedVersioned(
      `quotes:list:${orgId}`,
      key,
      async () => {
        const conditions = [eq(quotes.orgId, orgId), isNull(quotes.deletedAt)];
        if (status) conditions.push(eq(quotes.status, status));
        if (dealId) conditions.push(eq(quotes.dealId, dealId));
        if (search) conditions.push(ilike(quotes.subject, `%${search}%`));

        const position = decodeCursor(cursor);
        const where = position
          ? and(...conditions, keysetBefore(quotes.createdAt, quotes.id, position))
          : and(...conditions);

        const [rows, totalResult] = await Promise.all([
          this.db
            .select({
              id: quotes.id,
              orgId: quotes.orgId,
              dealId: quotes.dealId,
              clientId: quotes.clientId,
              quoteNumber: quotes.quoteNumber,
              subject: quotes.subject,
              status: quotes.status,
              currency: quotes.currency,
              totalAmount: quotes.totalAmount,
              netAmount: quotes.netAmount,
              validUntil: quotes.validUntil,
              createdById: quotes.createdById,
              sentAt: quotes.sentAt,
              acceptedAt: quotes.acceptedAt,
              createdAt: quotes.createdAt,
              updatedAt: quotes.updatedAt,
              createdByName: users.name,
              createdByImage: users.image,
              dealName: deals.name,
              clientName: clientAccounts.clientName,
            })
            .from(quotes)
            .leftJoin(users, eq(quotes.createdById, users.id))
            .leftJoin(deals, eq(quotes.dealId, deals.id))
            .leftJoin(clientAccounts, eq(quotes.clientId, clientAccounts.id))
            .where(where)
            .orderBy(desc(quotes.createdAt), desc(quotes.id))
            .limit(limit + 1),
          cursor === undefined
            ? this.db.select({ count: count() }).from(quotes).where(and(...conditions))
            : Promise.resolve(null),
        ]);

        const page = buildCursorPage(rows, limit, (q) => ({ sortValue: q.createdAt.toISOString(), id: String(q.id) }));
        return {
          quotes: page.data.map((q) => ({
            ...q,
            createdBy: q.createdByName
              ? { id: q.createdById, name: q.createdByName, image: q.createdByImage }
              : null,
            deal: q.dealId ? { id: q.dealId, name: q.dealName } : null,
            client: q.clientId ? { id: q.clientId, clientName: q.clientName } : null,
          })),
          hasMore: page.pagination.hasMore,
          nextCursor: page.pagination.nextCursor,
          total: totalResult ? (totalResult[0]?.count ?? 0) : undefined,
        };
      },
      LIST_TTL,
    );
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");

    const settings = await this.db.query.crmQuoteSettings.findFirst({
      where: eq(crmQuoteSettings.orgId, orgId),
    });

    const quote = await this.db.transaction(async (tx) => {
      const existingCount = await tx
        .select({ count: count() })
        .from(quotes)
        // Deliberately counts soft-deleted rows too: `idx_quotes_number` is a
        // NON-partial unique index on (org_id, quote_number), so excluding
        // deleted quotes would re-issue a number that still exists and fail.
        .where(and(eq(quotes.orgId, orgId), sql`DATE(${quotes.createdAt}) = CURRENT_DATE`));
      const seq = ((existingCount[0]?.count ?? 0) + 1).toString().padStart(3, "0");
      const quoteNumber = `QT-${dateStr}-${seq}`;

      let totalAmount = 0;
      let totalTax = 0;
      for (const item of input.lineItems) {
        const lineAmount = item.quantity * item.unitPrice;
        totalAmount += lineAmount;
        totalTax += lineAmount * ((item.taxRate ?? 0) / 100);
      }

      const discountPercent = input.discountPercent ?? 0;
      const discountAmount = totalAmount * (discountPercent / 100);
      const netAmount = totalAmount - discountAmount + totalTax;

      const expiryDays = settings?.defaultExpiryDays ?? 30;
      const validUntil = input.validUntil ?? addDays(today, expiryDays);

      const maxDiscount = settings?.maxDiscountPercent;
      const needsApproval =
        discountPercent > 0 &&
        maxDiscount !== null &&
        maxDiscount !== undefined &&
        discountPercent > maxDiscount;

      const approvalStatus: "pending" | undefined = needsApproval ? "pending" : undefined;

      const [created] = await tx
        .insert(quotes)
        .values({
          orgId,
          dealId: input.dealId ?? null,
          clientId: input.clientId ?? null,
          quoteNumber,
          subject: input.subject,
          description: input.description ?? null,
          status: "DRAFT",
          currency: input.currency ?? "INR",
          totalAmount: totalAmount.toFixed(2),
          taxAmount: totalTax.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          netAmount: netAmount.toFixed(2),
          validUntil,
          termsAndConditions: input.termsAndConditions ?? null,
          createdById: userId,
          notes: input.notes ?? null,
          pricebookId: input.pricebookId ?? null,
          templateId: input.templateId ?? null,
          approvalStatus,
        })
        .returning();

      await tx.insert(quoteLineItems).values(
        input.lineItems.map((item, idx) => ({
          quoteId: created.id,
          description: item.description,
          quantity: item.quantity.toFixed(2),
          unitPrice: item.unitPrice.toFixed(2),
          amount: (item.quantity * item.unitPrice).toFixed(2),
          taxRate: (item.taxRate ?? 0).toFixed(2),
          displayOrder: idx,
        })),
      );

      return created;
    });

    this.audit.log({
      action: "quote.created",
      userId,
      orgId,
      targetId: String(quote.id),
      targetType: "quote",
      metadata: { quoteNumber: quote.quoteNumber, subject: input.subject },
    });

    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);

    return quote;
  }

  getQuote(orgId: string, quoteId: number) {
    return this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      with: {
        lineItems: { orderBy: (li, { asc }) => [asc(li.displayOrder)] },
        createdBy: { columns: { id: true, name: true, image: true } },
        deal: { columns: { id: true, name: true } },
        client: { columns: { id: true, clientName: true } },
      },
    });
  }

  async update(orgId: string, userId: string, quoteId: number, input: UpdateInput) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      columns: { id: true },
    });
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (input.subject !== undefined) updateData.subject = input.subject;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.validUntil !== undefined) updateData.validUntil = input.validUntil;
    if (input.termsAndConditions !== undefined) updateData.termsAndConditions = input.termsAndConditions;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.rejectionReason !== undefined) updateData.rejectionReason = input.rejectionReason;
    if (input.pricebookId !== undefined) updateData.pricebookId = input.pricebookId;
    if (input.templateId !== undefined) updateData.templateId = input.templateId;

    if (input.status !== undefined) {
      updateData.status = input.status;
      if (input.status === "SENT") updateData.sentAt = new Date();
      if (input.status === "ACCEPTED") updateData.acceptedAt = new Date();
      if (input.status === "REJECTED") updateData.rejectedAt = new Date();
    }

    if (input.discountPercent !== undefined) {
      const settings = await this.db.query.crmQuoteSettings.findFirst({
        where: eq(crmQuoteSettings.orgId, orgId),
      });
      const maxDiscount = settings?.maxDiscountPercent;
      if (
        maxDiscount !== null &&
        maxDiscount !== undefined &&
        input.discountPercent > maxDiscount
      ) {
        updateData.approvalStatus = "pending";
      }
    }

    const updated = await this.db.transaction(async (tx) => {
      if (input.lineItems) {
        let totalAmount = 0;
        let totalTax = 0;
        for (const item of input.lineItems) {
          const lineAmount = item.quantity * item.unitPrice;
          totalAmount += lineAmount;
          totalTax += lineAmount * ((item.taxRate ?? 0) / 100);
        }
        const discountPercent = input.discountPercent ?? 0;
        const discountAmount = totalAmount * (discountPercent / 100);
        updateData.totalAmount = totalAmount.toFixed(2);
        updateData.taxAmount = totalTax.toFixed(2);
        updateData.discountAmount = discountAmount.toFixed(2);
        updateData.netAmount = (totalAmount - discountAmount + totalTax).toFixed(2);

        await tx.delete(quoteLineItems).where(eq(quoteLineItems.quoteId, quoteId));
        await tx.insert(quoteLineItems).values(
          input.lineItems.map((item, idx) => ({
            quoteId,
            description: item.description,
            quantity: item.quantity.toFixed(2),
            unitPrice: item.unitPrice.toFixed(2),
            amount: (item.quantity * item.unitPrice).toFixed(2),
            taxRate: (item.taxRate ?? 0).toFixed(2),
            displayOrder: idx,
          })),
        );
      }

      const [row] = await tx
        .update(quotes)
        .set(updateData)
        .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)))
        .returning();
      return row;
    });

    this.audit.log({
      action: input.status
        ? input.status === "ACCEPTED"
          ? "quote.accepted"
          : input.status === "REJECTED"
            ? "quote.rejected"
            : "quote.updated"
        : "quote.updated",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { changedFields: Object.keys(input), newStatus: input.status },
    });

    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);

    return updated;
  }

  async remove(orgId: string, userId: string, quoteId: number): Promise<{ success: true } | null> {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      columns: { quoteNumber: true },
    });
    if (!existing) return null;

    await this.db
      .update(quotes)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      );

    this.audit.log({
      action: "quote.deleted",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });

    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);

    return { success: true };
  }

  send(orgId: string, userId: string, quoteId: number) {
    return this.lifecycle.send(orgId, userId, quoteId);
  }

  approve(orgId: string, userId: string, quoteId: number) {
    return this.lifecycle.approve(orgId, userId, quoteId);
  }

  reject(orgId: string, userId: string, quoteId: number, reason?: string) {
    return this.lifecycle.reject(orgId, userId, quoteId, reason);
  }

  convertToInvoice(orgId: string, userId: string, quoteId: number) {
    return this.lifecycle.convertToInvoice(orgId, userId, quoteId);
  }

  markSigned(orgId: string, userId: string, quoteId: number, documentRef?: string) {
    return this.lifecycle.markSigned(orgId, userId, quoteId, documentRef);
  }

  buildExportCsv(orgId: string, userId: string, filters: ExportInput) {
    return this.lifecycle.buildExportCsv(orgId, userId, filters);
  }
}
