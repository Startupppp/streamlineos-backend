import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  accountingSettings,
  purchaseBills,
  purchaseBillItems,
  vendorPayments,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { JournalPostingService } from "../posting/journal-posting.service";
import { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import { RateResolverService } from "../../finance/controls/rate-resolver.service";
import { FxService } from "../../finance/controls/fx.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { systemActor } from "../../../common/auth/system-actor";
import type { DataScope } from "../../access/access.types";
import type {
  AgedReceivablesQuery,
  CreatePurchaseBillInput,
  ListCustomersOutstandingQuery,
  ListPurchaseBillsQuery,
  RecordVendorPaymentInput,
  UpdatePurchaseBillStatusInput,
} from "./dto/accounting.schemas";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class AccountingPayablesService {
  private readonly logger = new Logger(AccountingPayablesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly audit: AuditService,
    private readonly query: AccountingPayablesQueryService,
    private readonly rateResolver: RateResolverService,
    private readonly fx: FxService,
  ) {}

  listPurchaseBills(orgId: string, q: ListPurchaseBillsQuery, scope: DataScope, userId: string) {
    return this.query.listPurchaseBills(orgId, q, scope, userId);
  }

  getPurchaseBill(orgId: string, billId: number) {
    return this.query.getPurchaseBill(orgId, billId);
  }

  listBillPayments(orgId: string, billId: number) {
    return this.query.listBillPayments(orgId, billId);
  }

  listVendors(orgId: string, q: ListCustomersOutstandingQuery) {
    return this.query.listVendors(orgId, q);
  }

  vendorLedger(orgId: string, vendorId: number) {
    return this.query.vendorLedger(orgId, vendorId);
  }

  agedPayables(orgId: string, q: AgedReceivablesQuery) {
    return this.query.agedPayables(orgId, q);
  }

  async createPurchaseBill(orgId: string, userId: string, input: CreatePurchaseBillInput) {
    const itemsWithAmounts = input.items.map((it, idx) => {
      const amount = round2(it.quantity * it.rate);
      const tax = round2(amount * (it.gstRate / 100));
      return { ...it, amount, tax, lineOrder: idx };
    });
    const subtotal = round2(itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0));
    const taxPool = round2(itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0));
    const discount = round2(input.discount);
    const total = round2(subtotal + taxPool - discount);

    const supplierStateCode =
      input.supplierGstin && input.supplierGstin.length >= 2
        ? input.supplierGstin.slice(0, 2)
        : input.placeOfSupply ?? "";
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;

    const intra = supplierStateCode === placeOfSupplyStateCode && supplierStateCode !== "";
    const cgst = intra ? round2(taxPool / 2) : 0;
    const sgst = intra ? round2(taxPool - cgst) : 0;
    const igst = intra ? 0 : taxPool;

    if (input.status === "POSTED") {
      await this.posting.seedChartOfAccountsForOrg(orgId);
    }

    const created = await this.db.transaction(async (tx) => {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(purchaseBills)
        .where(eq(purchaseBills.orgId, orgId));
      const existingCount = countRows[0]?.count ?? 0;
      const billNumber = `BILL-${new Date(input.billDate).getFullYear()}-${String(existingCount + 1).padStart(4, "0")}`;

      const [inserted] = await tx
        .insert(purchaseBills)
        .values({
          orgId,
          vendorId: input.vendorId,
          billNumber,
          vendorBillNumber: input.vendorBillNumber ?? null,
          billDate: input.billDate,
          dueDate: input.dueDate ?? null,
          status: input.status,
          subtotal: subtotal.toFixed(4),
          taxAmount: taxPool.toFixed(4),
          cgstAmount: cgst.toFixed(4),
          sgstAmount: sgst.toFixed(4),
          igstAmount: igst.toFixed(4),
          discount: discount.toFixed(4),
          total: total.toFixed(4),
          currency: "INR",
          placeOfSupply: placeOfSupplyStateCode || null,
          vendorGstin: input.vendorGstin && input.vendorGstin.length > 0 ? input.vendorGstin : null,
          supplierGstin: input.supplierGstin && input.supplierGstin.length > 0 ? input.supplierGstin : null,
          reverseCharge: input.reverseCharge,
          notes: input.notes ?? null,
          expenseAccountCode: input.expenseAccountCode,
          createdBy: userId,
        })
        .returning();

      if (!inserted) throw new Error("Purchase bill insert returned no rows");

      if (itemsWithAmounts.length > 0) {
        await tx.insert(purchaseBillItems).values(
          itemsWithAmounts.map((it) => ({
            billId: inserted.id,
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

      if (input.status === "POSTED") {
        await this.posting.postPurchaseBill(
          {
            orgId,
            billId: inserted.id,
            billNumber: inserted.billNumber,
            billDate: inserted.billDate,
            supplierStateCode,
            placeOfSupplyStateCode,
            subtotal,
            discount,
            taxPool,
            total,
            expenseAccountCode: input.expenseAccountCode,
            createdBy: userId,
          },
          tx,
        );
      }

      return inserted;
    });

    this.audit.log({
      action: "accounting.bill.created",
      userId,
      orgId,
      resourceType: "purchase_bill",
      resourceId: String(created.id),
      metadata: { billNumber: created.billNumber, status: created.status },
      result: "SUCCESS",
    });

    return created;
  }

  async updatePurchaseBillStatus(
    orgId: string,
    userId: string,
    billId: number,
    input: UpdatePurchaseBillStatusInput,
  ) {
    const existingRows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new NotFoundException("Purchase bill not found");

    if (input.status === "POSTED") {
      if (existing.status !== "DRAFT") {
        throw new ConflictException(`Cannot post bill in status ${existing.status}`);
      }
      await this.posting.seedChartOfAccountsForOrg(orgId);

      await this.db.transaction(async (tx) => {
        await tx
          .update(purchaseBills)
          .set({ status: "POSTED", updatedAt: new Date() })
          .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

        const subtotal = Number(existing.subtotal ?? 0);
        const discount = Number(existing.discount ?? 0);
        const cgst = Number(existing.cgstAmount ?? 0);
        const sgst = Number(existing.sgstAmount ?? 0);
        const igst = Number(existing.igstAmount ?? 0);
        const taxPool = Math.round((cgst + sgst + igst) * 100) / 100;
        const total = Number(existing.total ?? 0);
        const supplierStateCode =
          existing.supplierGstin && existing.supplierGstin.length >= 2
            ? existing.supplierGstin.slice(0, 2)
            : existing.placeOfSupply ?? "";
        const placeOfSupplyStateCode = existing.placeOfSupply ?? supplierStateCode;

        await this.posting.postPurchaseBill(
          {
            orgId,
            billId: existing.id,
            billNumber: existing.billNumber,
            billDate: existing.billDate,
            supplierStateCode,
            placeOfSupplyStateCode,
            subtotal,
            discount,
            taxPool,
            total,
            expenseAccountCode: existing.expenseAccountCode ?? "5990",
            createdBy: userId,
          },
          tx,
        );
      });
    } else if (input.status === "CANCELLED") {
      if (
        existing.status === "POSTED" ||
        existing.status === "PARTIALLY_PAID" ||
        existing.status === "PAID"
      ) {
        throw new ConflictException("Cannot cancel a posted bill - reverse the journal entry instead");
      }
      await this.db
        .update(purchaseBills)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));
    }

    this.audit.log({
      action: "accounting.bill.status_updated",
      userId,
      orgId,
      resourceType: "purchase_bill",
      resourceId: String(billId),
      metadata: { status: input.status },
      result: "SUCCESS",
    });

    return { id: billId, status: input.status };
  }

  async recordBillPayment(
    orgId: string,
    userId: string,
    billId: number,
    input: RecordVendorPaymentInput,
  ) {
    const billRows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const bill = billRows[0];
    if (!bill) throw new NotFoundException("Purchase bill not found");
    if (bill.status === "DRAFT") throw new ConflictException("Post the bill before recording a payment");
    if (bill.status === "CANCELLED") throw new ConflictException("Cannot record payment on a cancelled bill");

    const total = Number(bill.total ?? 0);
    const alreadyPaid = Number(bill.amountPaid ?? 0);
    const remaining = total - alreadyPaid;
    if (input.amount > remaining + 0.01) {
      throw new BadRequestException(
        `Payment amount ${input.amount.toFixed(2)} exceeds remaining ${remaining.toFixed(2)}`,
      );
    }

    await this.posting.seedChartOfAccountsForOrg(orgId);

    const payment = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(vendorPayments)
        .values({
          orgId,
          billId,
          amount: input.amount.toFixed(2),
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        })
        .returning();
      if (!inserted) throw new Error("Vendor payment insert returned no rows");

      const newPaidTotal = await tx
        .select({ paid: sql<string>`COALESCE(sum(${vendorPayments.amount}::numeric), 0)::text` })
        .from(vendorPayments)
        .where(and(eq(vendorPayments.billId, billId), eq(vendorPayments.orgId, orgId)));
      const paidSum = Number(newPaidTotal[0]?.paid ?? 0);
      const nextStatus = paidSum >= total - 0.005 ? "PAID" : "PARTIALLY_PAID";

      await tx
        .update(purchaseBills)
        .set({ amountPaid: paidSum.toFixed(4), status: nextStatus, updatedAt: new Date() })
        .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)));

      await this.posting.postVendorPayment(
        {
          orgId,
          paymentId: inserted.id,
          billNumber: bill.billNumber,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          amount: input.amount,
          createdBy: userId,
        },
        tx,
      );

      return inserted;
    });

    await this.postApFxGainLoss(orgId, userId, bill, input.amount, input.paymentDate);

    this.audit.log({
      action: "accounting.bill.payment_recorded",
      userId,
      orgId,
      resourceType: "vendor_payment",
      resourceId: String(payment.id),
      metadata: { billId, amount: input.amount.toFixed(2) },
      result: "SUCCESS",
    });

    return payment;
  }

  private async postApFxGainLoss(
    orgId: string,
    userId: string,
    bill: { id: number; currency: string; exchangeRate: string; total: string },
    allocatedAmount: number,
    paymentDateIso: string,
  ): Promise<void> {
    const settingsRows = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    const baseCurrency = settingsRows[0]?.baseCurrency ?? "INR";

    if (bill.currency === baseCurrency) return;

    const bookedRate = Number(bill.exchangeRate ?? 1);
    const baseAmountBooked = (allocatedAmount * bookedRate).toFixed(4);

    try {
      const settledRate = await this.rateResolver.getRate(
        orgId,
        bill.currency,
        baseCurrency,
        new Date(`${paymentDateIso}T00:00:00.000Z`),
      );
      const baseAmountSettled = (allocatedAmount * settledRate).toFixed(4);

      const user = systemActor("accounting.payables.fx-posting", orgId, userId);

      await this.fx.postRealizedGainLoss(user, {
        sourceType: "purchase_bill",
        sourceId: String(bill.id),
        baseAmountBooked,
        baseAmountSettled,
        counterPurpose: "AP",
      });
    } catch (err) {
      this.logger.warn(
        `No exchange rate for FX on purchase_bill ${bill.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
