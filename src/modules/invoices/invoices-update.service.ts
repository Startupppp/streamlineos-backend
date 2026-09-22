import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { invoiceItems, invoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { PG_CHECK_VIOLATION, isCheckViolation } from "../../common/db/postgres-error";
import { InvoicesPostingService } from "./invoices-posting.service";
import { gstSplit, resolveSupplierStateCode } from "./lib/invoice-helpers";
import { computeInvoiceTotals, resolveLineItems } from "./lib/invoice-line-tax";
import { canPatchInvoiceStatus } from "./lib/invoice-transitions";
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
      if (!canPatchInvoiceStatus(existing.status, input.status)) {
        throw new ConflictException(
          `Invoice in status ${existing.status} cannot move to ${input.status}`,
        );
      }
      // The transition table admits ISSUED only from DRAFT, so this is always
      // the first issue. Nothing is seeded here: the chart is seeded once, by
      // accounting setup, when the organisation enables accounting.
      const willPost = input.status === "ISSUED";

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

      await this.guardImmutability(async () => this.db.transaction(async (tx) => {
        const stored = await tx
          .select({
            gstRate: invoiceItems.gstRate,
            hsnSacCode: invoiceItems.hsnSacCode,
            timesheetEntryId: invoiceItems.timesheetEntryId,
          })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, invoiceId))
          .orderBy(asc(invoiceItems.lineOrder), asc(invoiceItems.id));

        const lines = resolveLineItems(requested, stored);
        // Rupees throughout; gstRate/taxRate are percentages.
        const totals = computeInvoiceTotals(lines, blendedRate, discountInput);
        const split = gstSplit(
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
              timesheetEntryId: li.timesheetEntryId,
            })),
          );
        }
        await tx
          .update(invoices)
          .set(updateData)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)));
      }));
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

  /**
   * `existing.status` is read before the transaction opens, so a concurrent issue can flip the
   * invoice out of DRAFT between the guard above and the writes below. The database triggers
   * (`trg_invoice_immutability`, `trg_invoice_item_immutability`) are what actually stop the edit
   * at that point, and they raise `check_violation`. Unmapped that reached the client as a 500,
   * which reads as "the server is broken" rather than "somebody issued this invoice while you were
   * editing it".
   */
  private async guardImmutability<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (!isCheckViolation(error)) throw error;
      throw new ConflictException(
        InvoicesUpdateService.checkViolationMessage(error) ??
          "This invoice is no longer a draft and can no longer be edited",
      );
    }
  }

  /** The driver error carrying the SQLSTATE sits below Drizzle's wrapper, and only it has the text. */
  private static checkViolationMessage(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; current !== null && typeof current === "object" && depth < 6; depth += 1) {
      if (Reflect.get(current, "code") === PG_CHECK_VIOLATION) {
        const message: unknown = Reflect.get(current, "message");
        if (typeof message === "string" && message.length > 0) return message;
      }
      current = Reflect.get(current, "cause");
    }
    return undefined;
  }
}
