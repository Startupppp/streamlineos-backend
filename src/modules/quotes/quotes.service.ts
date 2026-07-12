import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import {
  clientAccounts,
  crmQuoteSettings,
  deals,
  invoices,
  invoiceItems,
  quoteLineItems,
  quotes,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateInput,
  ExportInput,
  ListInput,
  UpdateInput,
} from "./dto/quote.schemas";

const LIST_TTL = 30;

export type SendNotDraft = { error: "not_draft" };

export function isSendNotDraft(value: unknown): value is SendNotDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "not_draft"
  );
}

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
  ) {}

  async list(orgId: string, filters: ListInput) {
    const { status, dealId, search, page, pageSize } = filters;
    const limit = pageSize;
    const offset = (page - 1) * pageSize;

    const key = `quotes:list:${orgId}:${status ?? ""}:${dealId ?? ""}:${search ?? ""}:${limit}:${offset}`;
    return this.cache.cached(
      key,
      async () => {
        const conditions = [eq(quotes.orgId, orgId)];
        if (status) conditions.push(eq(quotes.status, status));
        if (dealId) conditions.push(eq(quotes.dealId, dealId));
        if (search) conditions.push(ilike(quotes.subject, `%${search}%`));

        const where = and(...conditions);

        const [data, totalResult] = await Promise.all([
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
            .orderBy(desc(quotes.createdAt))
            .limit(limit)
            .offset(offset),
          this.db.select({ count: count() }).from(quotes).where(where),
        ]);

        return {
          quotes: data.map((q) => ({
            ...q,
            createdBy: q.createdByName
              ? { id: q.createdById, name: q.createdByName, image: q.createdByImage }
              : null,
            deal: q.dealId ? { id: q.dealId, name: q.dealName } : null,
            client: q.clientId ? { id: q.clientId, clientName: q.clientName } : null,
          })),
          total: totalResult[0]?.count ?? 0,
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

    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);

    return quote;
  }

  getQuote(orgId: string, quoteId: number) {
    return this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
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
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
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
        .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
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

    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);

    return updated;
  }

  async remove(orgId: string, userId: string, quoteId: number): Promise<{ success: true } | null> {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
      columns: { quoteNumber: true },
    });
    if (!existing) return null;

    await this.db.delete(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)));

    this.audit.log({
      action: "quote.deleted",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });

    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);

    return { success: true };
  }

  async send(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
    });
    if (!existing) return null;
    if (existing.status !== "DRAFT") return { error: "not_draft" } satisfies SendNotDraft;
    if (existing.clientId === null) {
      throw new BadRequestException("Quote must have a linked contact or account before sending");
    }
    if (existing.approvalStatus === "pending") {
      throw new BadRequestException("Quote is pending approval and cannot be sent");
    }

    const [updated] = await this.db
      .update(quotes)
      .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(quotes.id, quoteId))
      .returning();

    this.audit.log({
      action: "quote.sent",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });

    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);

    return updated;
  }

  async approve(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.approvalStatus !== "pending") {
      throw new BadRequestException("Only pending quotes can be approved");
    }
    const [updated] = await this.db
      .update(quotes)
      .set({ approvalStatus: "approved", approvedById: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
      .returning();
    this.audit.log({
      action: "quote.approved",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });
    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);
    return updated;
  }

  async reject(orgId: string, userId: string, quoteId: number, reason?: string) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.approvalStatus !== "pending") {
      throw new BadRequestException("Only pending quotes can be rejected");
    }
    const setValues: Record<string, unknown> = {
      approvalStatus: "rejected",
      approvedById: userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    };
    if (reason !== undefined) setValues.rejectionReason = reason;
    const [updated] = await this.db
      .update(quotes)
      .set(setValues)
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
      .returning();
    this.audit.log({
      action: "quote.approval_rejected",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber, reason },
    });
    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);
    return updated;
  }

  async convertToInvoice(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
      with: { lineItems: { orderBy: (li, { asc }) => [asc(li.displayOrder)] } },
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.convertedInvoiceId !== null) {
      throw new ConflictException("Quote already converted to invoice");
    }
    if (existing.status !== "ACCEPTED") {
      throw new BadRequestException("Only accepted quotes can be converted to invoice");
    }

    const result = await this.db.transaction(async (tx) => {
      const today = new Date();
      const dateStr = today.toISOString().split("T")[0].replace(/-/g, "");
      const existingCount = await tx
        .select({ count: count() })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), sql`DATE(${invoices.createdAt}) = CURRENT_DATE`));
      const seq = ((existingCount[0]?.count ?? 0) + 1).toString().padStart(3, "0");
      const invoiceNumber = `INV-${dateStr}-${seq}`;

      let subtotal = 0;
      let taxAmount = 0;
      for (const item of existing.lineItems) {
        const line = Number(item.quantity) * Number(item.unitPrice);
        subtotal += line;
        taxAmount += line * (Number(item.taxRate) / 100);
      }
      const total = subtotal + taxAmount;

      const [invoice] = await tx
        .insert(invoices)
        .values({
          orgId,
          clientId: null,
          invoiceNumber,
          status: "DRAFT",
          lineItems: [],
          subtotal: subtotal.toFixed(4),
          taxRate: "0",
          taxAmount: taxAmount.toFixed(4),
          discount: "0",
          total: total.toFixed(4),
          currency: existing.currency,
          createdBy: userId,
        })
        .returning();

      if (existing.lineItems.length > 0) {
        await tx.insert(invoiceItems).values(
          existing.lineItems.map((item, idx) => ({
            invoiceId: invoice.id,
            description: item.description,
            hsnSacCode: null,
            quantity: item.quantity,
            rate: item.unitPrice,
            gstRate: item.taxRate,
            amount: item.amount,
            lineOrder: idx,
          })),
        );
      }

      await tx
        .update(quotes)
        .set({ convertedInvoiceId: invoice.id, updatedAt: new Date() })
        .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)));

      return invoice;
    });

    this.audit.log({
      action: "quote.converted_to_invoice",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber, invoiceId: result.id, invoiceNumber: result.invoiceNumber },
    });
    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);
    return { invoice: result, quoteId };
  }

  async markSigned(orgId: string, userId: string, quoteId: number, documentRef?: string) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.signedAt !== null) return existing;
    const [updated] = await this.db
      .update(quotes)
      .set({ signedAt: new Date(), signedDocumentRef: documentRef ?? null, updatedAt: new Date() })
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId)))
      .returning();
    this.audit.log({
      action: "quote.signed",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber, documentRef },
    });
    await this.cache.invalidatePattern(`quotes:list:${orgId}:*`);
    return updated;
  }

  async buildExportCsv(orgId: string, userId: string, filters: ExportInput): Promise<string> {
    const conditions = [eq(quotes.orgId, orgId)];
    if (filters.status) conditions.push(eq(quotes.status, filters.status));

    const data = await this.db
      .select({
        quoteNumber: quotes.quoteNumber,
        subject: quotes.subject,
        status: quotes.status,
        currency: quotes.currency,
        totalAmount: quotes.totalAmount,
        taxAmount: quotes.taxAmount,
        netAmount: quotes.netAmount,
        validUntil: quotes.validUntil,
        createdBy: users.name,
        dealName: deals.name,
        clientName: clientAccounts.clientName,
        createdAt: quotes.createdAt,
        sentAt: quotes.sentAt,
        acceptedAt: quotes.acceptedAt,
      })
      .from(quotes)
      .leftJoin(users, eq(quotes.createdById, users.id))
      .leftJoin(deals, eq(quotes.dealId, deals.id))
      .leftJoin(clientAccounts, eq(quotes.clientId, clientAccounts.id))
      .where(and(...conditions));

    const headers = [
      "Quote #", "Subject", "Status", "Currency", "Total", "Tax", "Net",
      "Valid Until", "Deal", "Client", "Created By", "Created At", "Sent At", "Accepted At",
    ];
    const rows = data.map((q) => [
      q.quoteNumber, q.subject, q.status, q.currency,
      q.totalAmount, q.taxAmount, q.netAmount, q.validUntil,
      q.dealName || "", q.clientName || "", q.createdBy || "",
      q.createdAt ? new Date(q.createdAt).toISOString() : "",
      q.sentAt ? new Date(q.sentAt).toISOString() : "",
      q.acceptedAt ? new Date(q.acceptedAt).toISOString() : "",
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    this.audit.log({
      action: "quote.exported",
      userId,
      orgId,
      metadata: { format: "csv", recordCount: rows.length },
    });

    return csv;
  }
}
