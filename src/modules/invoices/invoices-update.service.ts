import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { invoiceItems, invoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { resolveSupplierStateCode } from "./lib/invoice-helpers";
import { computeInvoiceTotals, resolveLineItems } from "./lib/invoice-line-tax";
import { canPatchInvoiceStatus } from "./lib/invoice-transitions";
import type { UpdateInvoiceInput } from "./dto/invoice-write.schemas";

@Injectable()
export class InvoicesUpdateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly audit: AuditService,
  ) {}

  async updateInvoice(
    orgId: string,
    userId: string,
    invoiceId: number,
    input: UpdateInvoiceInput,
  ): Promise<{ success: true; posted: boolean }> {
    const existing = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Invoice not found");

    if (input.status) {
      if (!canPatchInvoiceStatus(existing.status, input.status)) {
        throw new ConflictException(
          `Invoice in status ${existing.status} cannot move to ${input.status}`,
        );
      }
      const willPost = input.status === "ISSUED";
      if (willPost) await this.posting.seedChartOfAccountsForOrg(orgId);

      await this.db.transaction(async (tx) => {
        await tx
          .update(invoices)
          .set({
            status: input.status,
            updatedAt: new Date(),
            ...(input.status === "ISSUED" ? { sentAt: new Date() } : {}),
            ...(input.status === "PAID" ? { paidAt: new Date() } : {}),
          })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));

        if (willPost) {
          const subtotal = Number(existing.subtotal ?? 0);
          const discount = Number(existing.discount ?? 0);
          const cgst = Number(existing.cgstAmount ?? 0);
          const sgst = Number(existing.sgstAmount ?? 0);
          const igst = Number(existing.igstAmount ?? 0);
          const taxPool = Math.round((cgst + sgst + igst) * 100) / 100;
          const total = Number(existing.total ?? 0);
          const supplierStateCode = await resolveSupplierStateCode(
            this.db,
            orgId,
          );
          const placeOfSupplyStateCode =
            existing.placeOfSupply ?? supplierStateCode;
          const invoiceDate = (
            existing.createdAt ?? new Date()
          )
            .toISOString()
            .slice(0, 10);
          await this.posting.postInvoiceSend(
            {
              orgId,
              invoiceId: existing.id,
              invoiceNumber: existing.invoiceNumber,
              invoiceDate,
              supplierStateCode,
              placeOfSupplyStateCode,
              subtotal,
              discount,
              taxPool,
              total,
              createdBy: userId,
            },
            tx,
          );
        }
      });

      this.audit.log({
        action: "accounting.invoice.updated",
        userId,
        orgId,
        resourceType: "invoice",
        resourceId: String(invoiceId),
        metadata: { status: input.status },
        result: "SUCCESS",
      });

      return { success: true, posted: willPost };
    }

    if (existing.status !== "DRAFT") {
      throw new BadRequestException("Only draft invoices can be edited");
    }

    const updateData: Partial<typeof invoices.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.clientId !== undefined) updateData.clientId = input.clientId;
    if (input.projectId !== undefined) updateData.projectId = input.projectId;
    if (input.currency !== undefined) updateData.currency = input.currency;
    if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
    if (input.notes !== undefined) updateData.notes = input.notes;

    if (input.lineItems) {
      const requested = input.lineItems;
      // Read the same way the ISSUE branch above does, so the split written now
      // is the split read back then.
      const supplierStateCode = await resolveSupplierStateCode(this.db, orgId);
      const placeOfSupplyStateCode = existing.placeOfSupply ?? supplierStateCode;
      const blendedRate = input.taxRate ?? Number(existing.taxRate ?? 0);
      const discountInput = input.discount ?? Number(existing.discount ?? 0);

      await this.db.transaction(async (tx) => {
        const stored = await tx
          .select({
            gstRate: invoiceItems.gstRate,
            hsnSacCode: invoiceItems.hsnSacCode,
          })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, invoiceId))
          .orderBy(asc(invoiceItems.lineOrder), asc(invoiceItems.id));

        const lines = resolveLineItems(requested, stored);
        // Rupees throughout; gstRate/taxRate are percentages.
        const totals = computeInvoiceTotals(lines, blendedRate, discountInput);
        const split = this.posting.gstSplit(
          totals.taxPool,
          supplierStateCode,
          placeOfSupplyStateCode,
        );

        updateData.subtotal = totals.subtotal.toFixed(2);
        updateData.taxRate = totals.taxRate.toFixed(2);
        updateData.taxAmount = totals.taxPool.toFixed(2);
        updateData.discount = totals.discount.toFixed(2);
        updateData.total = totals.total.toFixed(2);
        // The split is part of the same fact as taxAmount. Leaving it at its
        // create-time value is what unbalanced the journal at issue.
        updateData.cgstAmount = split.cgst.toFixed(4);
        updateData.sgstAmount = split.sgst.toFixed(4);
        updateData.igstAmount = split.igst.toFixed(4);

        await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
        if (lines.length > 0) {
          await tx.insert(invoiceItems).values(
            lines.map((li, idx) => ({
              invoiceId,
              description: li.description,
              hsnSacCode: li.hsnSacCode,
              quantity: li.quantity.toFixed(4),
              rate: li.rate.toFixed(4),
              gstRate: li.gstRate.toFixed(2),
              amount: li.amount.toFixed(4),
              lineOrder: idx,
            })),
          );
        }
        await tx
          .update(invoices)
          .set(updateData)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));
      });
    } else {
      await this.db
        .update(invoices)
        .set(updateData)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));
    }

    this.audit.log({
      action: "accounting.invoice.updated",
      userId,
      orgId,
      resourceType: "invoice",
      resourceId: String(invoiceId),
      result: "SUCCESS",
    });

    return { success: true, posted: false };
  }
}
