import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lte } from "drizzle-orm";
import { invoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import { CacheService } from "../../common/cache/cache.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  round2,
  gstSplit,
  advanceDate,
  resolveSupplierStateCode,
} from "./lib/invoice-helpers";
import { assertTimesheetEntriesLinkable } from "./lib/timesheet-line-link";
import { assertDealBelongsToOrg, resolveProjectDealId } from "./lib/deal-link";
import { insertInvoiceWithItems } from "./lib/invoice-insert";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import { buildCloneInput } from "./lib/invoice-recurring-helpers";
import type {
  CreateInvoiceInput,
  RecordPaymentInput,
  UpdateInvoiceInput,
} from "./dto/invoice-write.schemas";

type InvoiceRow = typeof invoices.$inferSelect;

@Injectable()
export class InvoicesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: InvoicesPostingService,
    private readonly lifecycle: InvoicesLifecycleService,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly paymentService: InvoicesPaymentService,
    private readonly updateService: InvoicesUpdateService,
    private readonly cache: CacheService,
  ) {}

  async createInvoice(
    orgId: string,
    userId: string,
    input: CreateInvoiceInput,
  ): Promise<{ invoice: InvoiceRow; posted: boolean }> {
    await this.planLimits.assertWithinLimit(orgId, "acctInvoices");

    const status = input.status;

    const normalizedItems =
      input.items ??
      (input.lineItems ?? []).map((li) => ({
        description: li.description,
        hsnSacCode: undefined as string | undefined,
        quantity: li.quantity,
        rate: li.rate,
        gstRate: 0,
        timesheetEntryId: undefined as number | undefined,
      }));

    const itemsWithAmounts = normalizedItems.map((it, idx) => {
      const amount = round2(it.quantity * it.rate);
      const tax = round2(amount * (it.gstRate / 100));
      return { ...it, amount, tax, lineOrder: idx };
    });

    const subtotal = round2(
      itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0),
    );
    const taxPool = round2(
      itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0),
    );
    const discount = round2(input.discount);
    const total = round2(subtotal + taxPool - discount);

    await assertTimesheetEntriesLinkable(this.db, orgId, itemsWithAmounts);

    const dealId = input.dealId
      ? await assertDealBelongsToOrg(this.db, orgId, input.dealId)
      : await resolveProjectDealId(this.db, orgId, [input.projectId ?? null]);

    const supplierStateCode = await resolveSupplierStateCode(this.db, orgId);
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;
    const split = gstSplit(taxPool, supplierStateCode, placeOfSupplyStateCode);

    const invoice = await this.db.transaction(async (tx) => {
      const inserted = await insertInvoiceWithItems(
        tx,
        orgId,
        userId,
        {
          clientId: input.clientId,
          projectId: input.projectId,
          dealId,
          status,
          subtotal,
          taxPool,
          discount,
          total,
          currency: input.currency,
          dueDate: input.dueDate,
          notes: input.notes,
          placeOfSupply: placeOfSupplyStateCode,
          customerGstin: input.customerGstin,
          supplierGstin: input.supplierGstin,
          reverseCharge: input.reverseCharge,
          taxInclusive: input.taxInclusive,
          split,
        },
        itemsWithAmounts,
      );

      if (status === "ISSUED") {
        const invoiceDate = (inserted.createdAt ?? new Date())
          .toISOString()
          .slice(0, 10);
        await this.posting.postInvoiceIssued(
          orgId,
          userId,
          {
            invoiceId: inserted.id,
            invoiceNumber: inserted.invoiceNumber,
            invoiceDate,
            currency: inserted.currency,
            subtotal,
            discount,
            cgst: split.cgst,
            sgst: split.sgst,
            igst: split.igst,
            total,
          },
          tx,
        );
      }

      return inserted;
    });

    // `invoices:list` is the only namespace an invoice write makes stale that
    // anything still reads. Four `fin:*` bumps stood here — reports, tax
    // dashboard, tax reports and forecast — and every one of their readers lived
    // in `modules/finance/reports/`, which the accounting rewrite absorbed. With
    // the readers gone the bumps were four Redis INCRs per invoice write against
    // counters nobody consults.
    const invalidate = () => this.cache.invalidateNamespaceForOrg(orgId, "invoices:list");
    if (!registerAfterCommit(invalidate)) await invalidate();

    this.audit.log({
      action: "accounting.invoice.created",
      userId,
      orgId,
      resourceType: "invoice",
      resourceId: String(invoice.id),
      result: "SUCCESS",
    });

    return { invoice, posted: status === "ISSUED" };
  }

  async updateInvoice(
    orgId: string,
    userId: string,
    invoiceId: number,
    input: UpdateInvoiceInput,
  ): Promise<{ success: true; posted: boolean }> {
    const result = await this.updateService.updateInvoice(orgId, userId, invoiceId, input);
    const invalidate = () => this.cache.invalidateNamespaceForOrg(orgId, "invoices:list");
    if (!registerAfterCommit(invalidate)) await invalidate();
    return result;
  }

  recordPayment(
    orgId: string,
    userId: string,
    invoiceId: number,
    input: RecordPaymentInput,
  ) {
    return this.paymentService.recordPayment(orgId, userId, invoiceId, input);
  }

  async voidInvoice(
    orgId: string,
    userId: string,
    invoiceId: number,
  ): Promise<{ success: true }> {
    const { releasedTimesheetEntryIds } = await this.lifecycle.voidInvoice(
      orgId,
      userId,
      invoiceId,
    );
    const invalidate = () => this.cache.invalidateNamespaceForOrg(orgId, "invoices:list");
    if (!registerAfterCommit(invalidate)) await invalidate();

    this.audit.log({
      action: "accounting.invoice.voided",
      userId,
      orgId,
      resourceType: "invoice",
      resourceId: String(invoiceId),
      result: "SUCCESS",
      metadata: { releasedTimesheetEntryIds },
    });

    return { success: true };
  }

  markOverdueInvoices(orgId?: string): Promise<{ updated: number }> {
    return this.lifecycle.markOverdueInvoices(orgId);
  }

  async generateDueRecurringInvoices(
    orgId: string,
    userId: string,
    asOfDate: string,
  ) {
    const dueInvoices = await this.db.query.invoices.findMany({
      where: and(
        eq(invoices.orgId, orgId),
        eq(invoices.isRecurring, true),
        lte(invoices.nextRecurringDate, asOfDate),
      ),
      columns: {
        id: true,
        recurringInterval: true,
        nextRecurringDate: true,
      },
    });

    const invoiceIds: number[] = [];
    const failedIds: number[] = [];

    for (const due of dueInvoices) {
      if (!due.nextRecurringDate) continue;
      try {
        const advanced = advanceDate(due.nextRecurringDate, due.recurringInterval);
        const claimed = await this.db
          .update(invoices)
          .set({ nextRecurringDate: advanced, updatedAt: new Date() })
          .where(
            and(
              eq(invoices.id, due.id),
              eq(invoices.orgId, orgId),
              eq(invoices.nextRecurringDate, due.nextRecurringDate),
            ),
          )
          .returning({ id: invoices.id });
        if (claimed.length === 0) continue;

        const input = await buildCloneInput(this.db, due.id);
        const { invoice } = await this.createInvoice(orgId, userId, input);
        invoiceIds.push(invoice.id);
      } catch (error) {
        failedIds.push(due.id);
        logger.error("Recurring invoice clone failed", {
          orgId,
          sourceInvoiceId: due.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { generated: invoiceIds.length, invoiceIds, failedIds };
  }
}
