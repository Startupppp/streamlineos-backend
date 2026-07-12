import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { invoices, invoiceItems, payments, organizations, indianStates, finPaymentAllocations, journalEntries, journalLines, ledgerAccounts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { JournalPostingService, type DbOrTx } from "../accounting/journal-posting.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { CreateInvoiceInput, RecordPaymentInput, UpdateInvoiceInput } from "./dto/invoice-write.schemas";

const GST_RATES = [0, 5, 12, 18, 28] as const;
type GstRate = (typeof GST_RATES)[number];

type InvoiceRow = typeof invoices.$inferSelect;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function normalizeGstRate(value: string): GstRate {
  const parsed = Number(value);
  return (GST_RATES as ReadonlyArray<number>).includes(parsed) ? (parsed as GstRate) : 0;
}

function advanceDate(fromIso: string, interval: string | null): string {
  const d = new Date(`${fromIso}T00:00:00.000Z`);
  switch ((interval ?? "").trim().toLowerCase()) {
    case "weekly":
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "biweekly":
    case "fortnightly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "daily":
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "quarterly":
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "halfyearly":
    case "half-yearly":
    case "semiannually":
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case "yearly":
    case "annually":
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class InvoicesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async resolveSupplierStateCode(orgId: string): Promise<string> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { address: true },
    });
    const stateName = org?.address?.state;
    if (!stateName) return "";
    const match = await this.db
      .select({ stateCode: indianStates.stateCode })
      .from(indianStates)
      .where(eq(indianStates.stateName, stateName))
      .limit(1);
    return match[0]?.stateCode ?? "";
  }

  async createInvoice(
    orgId: string,
    userId: string,
    input: CreateInvoiceInput,
  ): Promise<{ invoice: InvoiceRow; posted: boolean }> {
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

    const subtotal = round2(itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0));
    const taxPool = round2(itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0));
    const discount = round2(input.discount);
    const total = round2(subtotal + taxPool - discount);

    const supplierStateCode = await this.resolveSupplierStateCode(orgId);
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;
    const split = this.posting.gstSplit(taxPool, supplierStateCode, placeOfSupplyStateCode);

    const legacyLineItemsMirror = itemsWithAmounts.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      rate: it.rate,
      amount: it.amount,
    }));

    if (status === "ISSUED") {
      await this.posting.seedChartOfAccountsForOrg(orgId);
    }

    const invoice = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || 'invoice'))`);

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
          lineItems: legacyLineItemsMirror,
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
        const invoiceDate = (inserted.createdAt ?? new Date()).toISOString().slice(0, 10);
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

    return { invoice, posted: status === "ISSUED" };
  }

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
      const willPost = input.status === "ISSUED" && existing.status !== "ISSUED";
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
          const supplierStateCode = await this.resolveSupplierStateCode(orgId);
          const placeOfSupplyStateCode = existing.placeOfSupply ?? supplierStateCode;
          const invoiceDate = (existing.createdAt ?? new Date()).toISOString().slice(0, 10);
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

      return { success: true, posted: willPost };
    }

    if (existing.status !== "DRAFT") {
      throw new BadRequestException("Only draft invoices can be edited");
    }

    const updateData: Partial<typeof invoices.$inferInsert> = { updatedAt: new Date() };
    if (input.clientId !== undefined) updateData.clientId = input.clientId;
    if (input.projectId !== undefined) updateData.projectId = input.projectId;
    if (input.currency !== undefined) updateData.currency = input.currency;
    if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
    if (input.notes !== undefined) updateData.notes = input.notes;

    if (input.lineItems) {
      const subtotal = Number(input.lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
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

    return { success: true, posted: false };
  }

  private async createPayment(
    orgId: string,
    invoiceId: number,
    data: RecordPaymentInput & { createdBy: string },
    tx: DbOrTx,
  ) {
    const [payment] = await tx
      .insert(payments)
      .values({
        orgId,
        invoiceId,
        amount: data.amount.toFixed(2),
        paymentDate: data.paymentDate,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber ?? null,
        notes: data.notes ?? null,
        createdBy: data.createdBy,
      })
      .returning();

    const [{ totalPaid }] = await tx
      .select({ totalPaid: sql<number>`COALESCE(sum(${payments.amount}::numeric), 0)::float` })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));

    const invoice = await tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      columns: { total: true, status: true },
    });

    if (invoice && Number(invoice.total) <= totalPaid && invoice.status !== "PAID") {
      await tx
        .update(invoices)
        .set({ status: "PAID", paidAt: new Date(), updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId));
    }

    return payment;
  }

  async recordPayment(orgId: string, userId: string, invoiceId: number, input: RecordPaymentInput) {
    const invoice = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === "VOIDED") {
      throw new BadRequestException("Cannot record payment on voided invoice");
    }

    const [{ totalPaid }] = await this.db
      .select({ totalPaid: sql<number>`COALESCE(sum(${payments.amount}::numeric), 0)::float` })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.orgId, orgId)));
    const remaining = Number(invoice.total ?? 0) - totalPaid;
    if (input.amount > remaining + 0.01) {
      throw new BadRequestException(
        `Payment amount ${input.amount.toFixed(2)} exceeds outstanding balance ${remaining.toFixed(2)}`,
      );
    }

    await this.posting.seedChartOfAccountsForOrg(orgId);

    return this.db.transaction(async (tx) => {
      const created = await this.createPayment(orgId, invoiceId, { ...input, createdBy: userId }, tx);
      await this.posting.postPaymentReceipt(
        {
          orgId,
          paymentId: created.id,
          invoiceNumber: invoice.invoiceNumber,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          amount: input.amount,
          createdBy: userId,
        },
        tx,
      );
      return created;
    });
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

    const lineItems = source.lineItems.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      rate: line.rate,
      amount: line.amount,
    }));

    return {
      clientId: source.clientId ?? undefined,
      projectId: source.projectId ?? undefined,
      items: items.length > 0 ? items : undefined,
      lineItems: items.length > 0 ? undefined : lineItems,
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

  async generateDueRecurringInvoices(orgId: string, userId: string, asOfDate: string) {
    const dueInvoices = await this.db.query.invoices.findMany({
      where: and(eq(invoices.orgId, orgId), eq(invoices.isRecurring, true), lte(invoices.nextRecurringDate, asOfDate)),
      columns: { id: true, recurringInterval: true, nextRecurringDate: true },
    });

    const invoiceIds: number[] = [];
    const failedIds: number[] = [];

    for (const due of dueInvoices) {
      try {
        const input = await this.buildCloneInput(due.id);
        const advanced = advanceDate(due.nextRecurringDate ?? asOfDate, due.recurringInterval);
        const { invoice } = await this.createInvoice(orgId, userId, input);
        await this.db
          .update(invoices)
          .set({ nextRecurringDate: advanced, updatedAt: new Date() })
          .where(and(eq(invoices.id, due.id), eq(invoices.orgId, orgId)));
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
