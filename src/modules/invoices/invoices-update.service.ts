import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { invoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { AuditService } from "../../common/audit/audit.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import type { UpdateInvoiceInput } from "./dto/invoice-write.schemas";

@Injectable()
export class InvoicesUpdateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: InvoicesPostingService,
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
          const total = Number(existing.total ?? 0);
          const invoiceDate = (
            existing.createdAt ?? new Date()
          )
            .toISOString()
            .slice(0, 10);
          // The GST split was frozen onto the row when the invoice was built;
          // re-deriving it here would let a later change of org address rewrite
          // history, so the stored components are posted as they stand.
          await this.posting.postInvoiceIssued(
            orgId,
            userId,
            {
              invoiceId: existing.id,
              invoiceNumber: existing.invoiceNumber,
              invoiceDate,
              currency: existing.currency,
              subtotal,
              discount,
              cgst,
              sgst,
              igst,
              total,
            },
            tx,
          );
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "invoice",
            aggregateId: String(invoiceId),
            aggregateVersion: Date.now(),
            eventType: "accounting.invoice.issued",
            payload: {
              organization_id: orgId,
              invoice_id: invoiceId,
              invoice_number: existing.invoiceNumber,
              total_cents: Math.round(total * 100),
              client_id: existing.clientId ?? null,
              actor_user_id: userId,
            },
            occurredAt: new Date(),
          });
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
      const subtotal = Number(
        input.lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2),
      );
      const taxRate = input.taxRate ?? Number(existing.taxRate ?? 0);
      const discount = input.discount ?? Number(existing.discount ?? 0);
      const taxAmount = Number((subtotal * (taxRate / 100)).toFixed(2));
      const total = Number((subtotal + taxAmount - discount).toFixed(2));

      updateData.lineItems = input.lineItems;
      updateData.subtotal = subtotal.toString();
      updateData.taxRate = taxRate.toString();
      updateData.taxAmount = taxAmount.toString();
      updateData.discount = discount.toString();
      updateData.total = total.toString();
    }

    await this.db
      .update(invoices)
      .set(updateData)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));

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
