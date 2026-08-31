import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invoiceItems, invoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { resolveSupplierStateCode } from "./lib/invoice-helpers";
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
      const willPost =
        input.status === "ISSUED" && existing.status !== "ISSUED";
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
      const newLineItems = input.lineItems;
      const subtotal = Number(
        newLineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2),
      );
      const taxRate = input.taxRate ?? Number(existing.taxRate ?? 0);
      const discount = input.discount ?? Number(existing.discount ?? 0);
      const taxAmount = Number((subtotal * (taxRate / 100)).toFixed(2));
      const total = Number((subtotal + taxAmount - discount).toFixed(2));

      updateData.subtotal = subtotal.toString();
      updateData.taxRate = taxRate.toString();
      updateData.taxAmount = taxAmount.toString();
      updateData.discount = discount.toString();
      updateData.total = total.toString();

      await this.db.transaction(async (tx) => {
        await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
        if (newLineItems.length > 0) {
          await tx.insert(invoiceItems).values(
            newLineItems.map((li, idx) => ({
              invoiceId,
              description: li.description,
              hsnSacCode: null,
              quantity: li.quantity.toFixed(4),
              rate: li.rate.toFixed(4),
              gstRate: "0.00",
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
