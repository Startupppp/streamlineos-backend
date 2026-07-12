import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, ilike, sql } from "drizzle-orm";
import { clientAccounts, deals, invoiceItems, invoices, quoteLineItems, quotes, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CrmAutomationBusService } from "../crm-automation-studio/crm-automation-bus.service";
import type { ExportInput } from "./dto/quote.schemas";

export type SendNotDraft = { error: "not_draft" };

export function isSendNotDraft(value: unknown): value is SendNotDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "not_draft"
  );
}

@Injectable()
export class QuotesLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly bus: CrmAutomationBusService,
  ) {}

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

    void this.bus.emit(orgId, "quote.sent", { entityType: "quote", entityId: String(quoteId), data: { quoteNumber: existing.quoteNumber, dealId: existing.dealId, clientId: existing.clientId }, actorId: userId }).catch(() => undefined);

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

    void this.bus.emit(orgId, "quote.signed", { entityType: "quote", entityId: String(quoteId), data: { quoteNumber: existing.quoteNumber, dealId: existing.dealId, clientId: existing.clientId, documentRef: documentRef ?? null }, actorId: userId }).catch(() => undefined);

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
