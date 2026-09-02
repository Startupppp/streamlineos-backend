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
  ListPurchaseBillsQuery,
  ListVendorsQuery,
  RecordVendorPaymentInput,
  UpdatePurchaseBillStatusInput,
} from "./dto/accounting.schemas";
import {
  addDecimals,
  allocateDecimal,
  compareDecimals,
  decimalFromNumber,
  divideDecimals,
  formatDecimal,
  multiplyDecimals,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
} from "./money.util";

function amountOf(quantity: number, rate: number): string {
  return multiplyDecimals(decimalFromNumber(quantity), decimalFromNumber(rate));
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

  listPurchaseBills(orgId: string, q: ListPurchaseBillsQuery, scope: DataScope, membershipId: number | null) {
    return this.query.listPurchaseBills(orgId, q, scope, membershipId);
  }

  getPurchaseBill(orgId: string, billId: number) {
    return this.query.getPurchaseBill(orgId, billId);
  }

  listBillPayments(orgId: string, billId: number) {
    return this.query.listBillPayments(orgId, billId);
  }

  listVendors(orgId: string, q: ListVendorsQuery) {
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
      const amount = roundDecimal(amountOf(it.quantity, it.rate), 2);
      const tax = roundDecimal(
        divideDecimals(multiplyDecimals(amount, decimalFromNumber(it.gstRate)), "100"),
        2,
      );
      return { ...it, amount, tax, lineOrder: idx };
    });
    const subtotal = sumDecimals(itemsWithAmounts.map((it) => it.amount));
    const taxPool = sumDecimals(itemsWithAmounts.map((it) => it.tax));
    const discount = roundDecimal(decimalFromNumber(input.discount), 2);
    const total = subtractDecimals(addDecimals(subtotal, taxPool), discount);

    const supplierStateCode =
      input.supplierGstin && input.supplierGstin.length >= 2
        ? input.supplierGstin.slice(0, 2)
        : input.placeOfSupply ?? "";
    const placeOfSupplyStateCode = input.placeOfSupply ?? supplierStateCode;

    const intra = supplierStateCode === placeOfSupplyStateCode && supplierStateCode !== "";
    const halves = allocateDecimal(taxPool, ["1", "1"]);
    const cgst = intra ? halves[0] : "0";
    const sgst = intra ? halves[1] : "0";
    const igst = intra ? "0" : taxPool;

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
          subtotal: formatDecimal(subtotal),
          taxAmount: formatDecimal(taxPool),
          cgstAmount: formatDecimal(cgst),
          sgstAmount: formatDecimal(sgst),
          igstAmount: formatDecimal(igst),
          discount: formatDecimal(discount),
          total: formatDecimal(total),
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
            quantity: decimalFromNumber(it.quantity),
            rate: decimalFromNumber(it.rate),
            gstRate: roundDecimal(decimalFromNumber(it.gstRate), 2),
            amount: formatDecimal(it.amount),
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
            subtotal: Number(subtotal),
            discount: Number(discount),
            taxPool: Number(taxPool),
            total: Number(total),
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

        const subtotal = toDecimal(existing.subtotal);
        const discount = toDecimal(existing.discount);
        const taxPool = sumDecimals([
          existing.cgstAmount,
          existing.sgstAmount,
          existing.igstAmount,
        ]);
        const total = toDecimal(existing.total);
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
            subtotal: Number(subtotal),
            discount: Number(discount),
            taxPool: Number(taxPool),
            total: Number(total),
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

    const total = toDecimal(bill.total);
    const remaining = subtractDecimals(total, toDecimal(bill.amountPaid));
    const requested = decimalFromNumber(input.amount);
    if (compareDecimals(requested, remaining) > 0) {
      throw new BadRequestException(
        `Payment amount ${roundDecimal(requested, 2)} exceeds remaining ${roundDecimal(remaining, 2)}`,
      );
    }

    await this.posting.seedChartOfAccountsForOrg(orgId);

    const payment = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(vendorPayments)
        .values({
          orgId,
          billId,
          amount: roundDecimal(requested, 2),
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
      const paidSum = toDecimal(newPaidTotal[0]?.paid);
      const nextStatus =
        compareDecimals(roundDecimal(paidSum, 2), roundDecimal(total, 2)) >= 0
          ? "PAID"
          : "PARTIALLY_PAID";

      await tx
        .update(purchaseBills)
        .set({ amountPaid: formatDecimal(paidSum), status: nextStatus, updatedAt: new Date() })
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
      metadata: { billId, amount: roundDecimal(requested, 2) },
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

    const allocated = decimalFromNumber(allocatedAmount);
    const baseAmountBooked = multiplyDecimals(allocated, toDecimal(bill.exchangeRate));

    try {
      const settledRate = await this.rateResolver.getRate(
        orgId,
        bill.currency,
        baseCurrency,
        new Date(`${paymentDateIso}T00:00:00.000Z`),
      );
      const baseAmountSettled = multiplyDecimals(allocated, decimalFromNumber(settledRate));

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
