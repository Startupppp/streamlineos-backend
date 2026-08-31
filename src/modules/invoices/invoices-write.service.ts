import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { invoices, invoiceItems } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  round2,
  normalizeGstRate,
  advanceDate,
  resolveSupplierStateCode,
} from "./lib/invoice-helpers";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { InvoicesUpdateService } from "./invoices-update.service";
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
    private readonly posting: JournalPostingService,
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

    const supplierStateCode = await resolveSupplierStateCode(this.db, orgId);
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;
    const split = this.posting.gstSplit(
      taxPool,
      supplierStateCode,
      placeOfSupplyStateCode,
    );

    if (status === "ISSUED") {
      await this.posting.seedChartOfAccountsForOrg(orgId);
    }

    const invoice = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || 'invoice'))`,
      );

      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(invoices)
        .where(eq(invoices.orgId, orgId));
      const nextNum = (countRows[0]?.count ?? 0) + 1;
      const invoiceNumber = `INV-${new Date().getFullYear()}-${String(nextNum).padStart(4, "0")}`;

      const [inserted] = await tx
        .insert(invoices)
        .values({
          orgId,
          clientId: input.clientId,
          projectId: input.projectId,
          invoiceNumber,
          status,
          subtotal: subtotal.toFixed(2),
          taxRate: "0",
          taxAmount: taxPool.toFixed(2),
          discount: discount.toFixed(2),
          total: total.toFixed(2),
          currency: input.currency,
          dueDate: input.dueDate,
          notes: input.notes,
          placeOfSupply: placeOfSupplyStateCode || null,
          customerGstin: input.customerGstin ?? null,
          supplierGstin: input.supplierGstin ?? null,
          reverseCharge: input.reverseCharge ?? false,
          taxInclusive: input.taxInclusive ?? false,
          cgstAmount: split.cgst.toFixed(4),
          sgstAmount: split.sgst.toFixed(4),
          igstAmount: split.igst.toFixed(4),
          sentAt: status === "ISSUED" ? new Date() : undefined,
          createdBy: userId,
        })
        .returning();

      if (!inserted) throw new Error("Invoice insert returned no rows");

      if (itemsWithAmounts.length > 0) {
        await tx.insert(invoiceItems).values(
          itemsWithAmounts.map((it) => ({
            invoiceId: inserted.id,
            description: it.description,
            hsnSacCode: it.hsnSacCode ?? null,
            quantity: it.quantity.toFixed(4),
            rate: it.rate.toFixed(4),
            gstRate: it.gstRate.toFixed(2),
            amount: it.amount.toFixed(4),
            lineOrder: it.lineOrder,
          })),
        );
      }

      if (status === "ISSUED") {
        const invoiceDate = (inserted.createdAt ?? new Date())
          .toISOString()
          .slice(0, 10);
        await this.posting.postInvoiceSend(
          {
            orgId,
            invoiceId: inserted.id,
            invoiceNumber: inserted.invoiceNumber,
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

      return inserted;
    });

    const invalidate = () => Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId)),
      this.cache.invalidateNamespaceForOrg(orgId, "invoices:list"),
    ]);
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
    const invalidate = () => Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId)),
      this.cache.invalidateNamespaceForOrg(orgId, "invoices:list"),
    ]);
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
    const result = await this.lifecycle.voidInvoice(orgId, userId, invoiceId);
    const invalidate = () => Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finTaxReportsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId)),
      this.cache.invalidateNamespaceForOrg(orgId, "invoices:list"),
    ]);
    if (!registerAfterCommit(invalidate)) await invalidate();
    return result;
  }

  markOverdueInvoices(orgId?: string): Promise<{ updated: number }> {
    return this.lifecycle.markOverdueInvoices(orgId);
  }

  private async buildCloneInput(sourceId: number): Promise<CreateInvoiceInput> {
    const source = await this.db.query.invoices.findFirst({
      where: eq(invoices.id, sourceId),
      with: { items: { orderBy: [asc(invoiceItems.lineOrder)] } },
    });
    if (!source) throw new Error(`Recurring source invoice ${sourceId} not found`);

    const items = source.items.map((item) => ({
      description: item.description,
      hsnSacCode: item.hsnSacCode ?? undefined,
      quantity: Number(item.quantity),
      rate: Number(item.rate),
      gstRate: normalizeGstRate(item.gstRate),
    }));

    return {
      clientId: source.clientId ?? undefined,
      projectId: source.projectId ?? undefined,
      items: items.length > 0 ? items : undefined,
      taxRate: 0,
      discount: Number(source.discount ?? "0"),
      currency: source.currency,
      notes: source.notes ?? undefined,
      status: "DRAFT",
      placeOfSupply: source.placeOfSupply ?? undefined,
      customerGstin: source.customerGstin ?? undefined,
      supplierGstin: source.supplierGstin ?? undefined,
      reverseCharge: source.reverseCharge,
      taxInclusive: source.taxInclusive,
    };
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

        const input = await this.buildCloneInput(due.id);
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
