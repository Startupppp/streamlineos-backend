import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { invoiceItems, invoices, projects, quotes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { ExportInput } from "./dto/quote.schemas";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { buildQuotesExportCsv } from "./lib/quotes-export";

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
    private readonly planLimits: PlanLimitsService,
  ) {}

  async send(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
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
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)))
      .returning();

    this.audit.log({
      action: "quote.sent",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });

    void this.bus.emit(orgId, "quote.sent", { entityType: "quote", entityId: String(quoteId), data: { quoteNumber: existing.quoteNumber, dealId: existing.dealId, clientId: existing.clientId }, actorId: userId }).catch(logSideEffectFailure("quote.sent automation bus emit", { orgId, quoteId }));

    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);

    return updated;
  }

  async approve(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.approvalStatus !== "pending") {
      throw new BadRequestException("Only pending quotes can be approved");
    }
    const [updated] = await this.db
      .update(quotes)
      .set({ approvalStatus: "approved", approvedById: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)))
      .returning();
    this.audit.log({
      action: "quote.approved",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber },
    });
    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);
    return updated;
  }

  async reject(orgId: string, userId: string, quoteId: number, reason?: string) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
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
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)))
      .returning();
    this.audit.log({
      action: "quote.approval_rejected",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber, reason },
    });
    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);
    return updated;
  }

  async convertToInvoice(orgId: string, userId: string, quoteId: number) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      with: { lineItems: { orderBy: (li, { asc }) => [asc(li.displayOrder)] } },
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.convertedInvoiceId !== null) {
      throw new ConflictException("Quote already converted to invoice");
    }
    if (existing.status !== "ACCEPTED") {
      throw new BadRequestException("Only accepted quotes can be converted to invoice");
    }

    await this.planLimits.assertWithinLimit(orgId, "acctInvoices");
    const project = existing.dealId === null
      ? null
      : await this.db.query.projects.findFirst({
        where: and(
          eq(projects.orgId, orgId),
          eq(projects.dealId, existing.dealId),
          isNull(projects.deletedAt),
        ),
        columns: { id: true },
      });

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
          clientId: existing.clientId,
          projectId: project?.id ?? null,
          dealId: existing.dealId,
          invoiceNumber,
          status: "DRAFT",
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
        .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)));

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
    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);
    return { invoice: result, quoteId };
  }

  async markSigned(orgId: string, userId: string, quoteId: number, documentRef?: string) {
    const existing = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
    });
    if (!existing) throw new NotFoundException("Quote not found");
    if (existing.signedAt !== null) return existing;
    const [updated] = await this.db
      .update(quotes)
      .set({ signedAt: new Date(), signedDocumentRef: documentRef ?? null, updatedAt: new Date() })
      .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)))
      .returning();
    this.audit.log({
      action: "quote.signed",
      userId,
      orgId,
      targetId: String(quoteId),
      targetType: "quote",
      metadata: { quoteNumber: existing.quoteNumber, documentRef },
    });

    void this.bus.emit(orgId, "quote.signed", { entityType: "quote", entityId: String(quoteId), data: { quoteNumber: existing.quoteNumber, dealId: existing.dealId, clientId: existing.clientId, documentRef: documentRef ?? null }, actorId: userId }).catch(logSideEffectFailure("quote.signed automation bus emit", { orgId, quoteId }));

    await this.cache.invalidateNamespace(`quotes:list:${orgId}`);
    return updated;
  }

  buildExportCsv(orgId: string, userId: string, filters: ExportInput): Promise<string> {
    return buildQuotesExportCsv(this.db, orgId, userId, filters, this.audit);
  }
}
