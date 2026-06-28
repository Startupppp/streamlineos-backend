import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  clients,
  ledgerAccounts,
  journalEntries,
  journalLines,
  purchaseBills,
  purchaseBillItems,
  vendorPayments,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import { JournalPostingService } from "./journal-posting.service";
import type { AgedPayablesRow, VendorLedgerLine } from "./accounting.types";
import {
  type AgedReceivablesQuery,
  type CreatePurchaseBillInput,
  type ListCustomersOutstandingQuery,
  type ListPurchaseBillsQuery,
  type RecordVendorPaymentInput,
  type UpdatePurchaseBillStatusInput,
} from "./dto/accounting.schemas";

const AP_ACCOUNT_CODE = "2000";
const OUTSTANDING_BILL_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%");
}

function bucketFor(daysOverdue: number): "current" | "d1_30" | "d31_60" | "d61_90" | "d91_plus" {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d91_plus";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

const BILL_COLUMNS = {
  id: purchaseBills.id,
  orgId: purchaseBills.orgId,
  vendorId: purchaseBills.vendorId,
  vendorName: clients.name,
  billNumber: purchaseBills.billNumber,
  vendorBillNumber: purchaseBills.vendorBillNumber,
  billDate: purchaseBills.billDate,
  dueDate: purchaseBills.dueDate,
  status: purchaseBills.status,
  subtotal: purchaseBills.subtotal,
  taxAmount: purchaseBills.taxAmount,
  cgstAmount: purchaseBills.cgstAmount,
  sgstAmount: purchaseBills.sgstAmount,
  igstAmount: purchaseBills.igstAmount,
  discount: purchaseBills.discount,
  total: purchaseBills.total,
  amountPaid: purchaseBills.amountPaid,
  currency: purchaseBills.currency,
  placeOfSupply: purchaseBills.placeOfSupply,
  vendorGstin: purchaseBills.vendorGstin,
  supplierGstin: purchaseBills.supplierGstin,
  reverseCharge: purchaseBills.reverseCharge,
  notes: purchaseBills.notes,
  expenseAccountCode: purchaseBills.expenseAccountCode,
  createdBy: purchaseBills.createdBy,
  createdAt: purchaseBills.createdAt,
  updatedAt: purchaseBills.updatedAt,
};

@Injectable()
export class AccountingPayablesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
  ) {}

  async listPurchaseBills(orgId: string, query: ListPurchaseBillsQuery, scope: DataScope, userId: string) {
    const { page, pageSize, q, status, vendorId } = query;
    const conds = [eq(purchaseBills.orgId, orgId)];
    if (status) conds.push(eq(purchaseBills.status, status));
    if (vendorId) conds.push(eq(purchaseBills.vendorId, vendorId));
    if (q) conds.push(ilike(purchaseBills.billNumber, `%${escapeLike(q)}%`));
    conds.push(applyScope(scope, userId, { ownerColumn: purchaseBills.createdBy }));

    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });
    const items = await this.db
      .select(BILL_COLUMNS)
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(where)
      .orderBy(desc(purchaseBills.billDate), asc(purchaseBills.id))
      .offset(offset)
      .limit(limit);
    const totalRows = await this.db.select({ c: count() }).from(purchaseBills).where(where);
    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
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

    return this.db.transaction(async (tx) => {
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
  }

  async getPurchaseBill(orgId: string, billId: number) {
    const rows = await this.db
      .select(BILL_COLUMNS)
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const header = rows[0];
    if (!header) throw new NotFoundException("Purchase bill not found");

    const items = await this.db
      .select()
      .from(purchaseBillItems)
      .where(eq(purchaseBillItems.billId, billId))
      .orderBy(asc(purchaseBillItems.lineOrder));

    return { ...header, items };
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

    return { id: billId, status: input.status };
  }

  async listBillPayments(orgId: string, billId: number) {
    const bills = await this.db
      .select({ id: purchaseBills.id })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    if (!bills[0]) throw new NotFoundException("Purchase bill not found");

    return this.db
      .select()
      .from(vendorPayments)
      .where(eq(vendorPayments.billId, billId))
      .orderBy(asc(vendorPayments.paymentDate), asc(vendorPayments.id));
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

    return this.db.transaction(async (tx) => {
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
        .where(eq(vendorPayments.billId, billId));
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
  }

  async listVendors(orgId: string, query: ListCustomersOutstandingQuery) {
    const { page, pageSize, q, onlyOutstanding } = query;
    const conds = [eq(clients.orgId, orgId), eq(clients.isVendor, true)];
    if (q) conds.push(ilike(clients.name, `%${escapeLike(q)}%`));

    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });
    const rows = await this.db
      .select({
        vendorId: clients.id,
        vendorName: clients.name,
        state: clients.state,
        gstin: clients.gstin,
        billCount: sql<number>`COALESCE((SELECT count(*)::int FROM ${purchaseBills} WHERE ${purchaseBills.vendorId} = ${clients.id} AND ${purchaseBills.status} IN ('POSTED','PARTIALLY_PAID','PAID')), 0)`,
        totalBilled: sql<string>`COALESCE((SELECT sum(${purchaseBills.total}::numeric) FROM ${purchaseBills} WHERE ${purchaseBills.vendorId} = ${clients.id} AND ${purchaseBills.status} IN ('POSTED','PARTIALLY_PAID','PAID')), 0)::text`,
        totalPaid: sql<string>`COALESCE((SELECT sum(${purchaseBills.amountPaid}::numeric) FROM ${purchaseBills} WHERE ${purchaseBills.vendorId} = ${clients.id} AND ${purchaseBills.status} IN ('POSTED','PARTIALLY_PAID','PAID')), 0)::text`,
      })
      .from(clients)
      .where(where)
      .offset(offset)
      .limit(limit);

    const items = rows
      .map((r) => ({
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        state: r.state,
        gstin: r.gstin,
        billCount: Number(r.billCount ?? 0),
        outstanding: (Number(r.totalBilled ?? 0) - Number(r.totalPaid ?? 0)).toFixed(2),
      }))
      .filter((r) => !onlyOutstanding || Number(r.outstanding) > 0.005);

    const totalRows = await this.db.select({ c: count() }).from(clients).where(where);
    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
  }

  async vendorLedger(orgId: string, vendorId: number) {
    const vendorRows = await this.db
      .select()
      .from(clients)
      .where(and(eq(clients.id, vendorId), eq(clients.orgId, orgId)))
      .limit(1);
    const vendor = vendorRows[0];
    if (!vendor) throw new NotFoundException("Vendor not found");

    const apAccount = await this.db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.orgId, orgId), eq(ledgerAccounts.code, AP_ACCOUNT_CODE)))
      .limit(1);
    const apAccountId = apAccount[0]?.id;

    const billRows = await this.db
      .select({
        id: purchaseBills.id,
        billNumber: purchaseBills.billNumber,
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
      })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          eq(purchaseBills.vendorId, vendorId),
          inArray(purchaseBills.status, [...OUTSTANDING_BILL_STATUSES]),
        ),
      );

    const billIds = billRows.map((b) => String(b.id));
    const billNumberById = new Map<string, string>(billRows.map((b) => [String(b.id), b.billNumber]));
    const totalBilled = billRows.reduce((acc, b) => acc + Number(b.total ?? 0), 0);
    const totalPaid = billRows.reduce((acc, b) => acc + Number(b.amountPaid ?? 0), 0);

    const lines: VendorLedgerLine[] = [];
    if (apAccountId && billIds.length > 0) {
      const journalRows = await this.db
        .select({
          date: journalEntries.entryDate,
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          sourceType: journalEntries.sourceType,
          sourceEvent: journalEntries.sourceEvent,
          sourceId: journalEntries.sourceId,
          description: journalEntries.description,
          debit: journalLines.debit,
          credit: journalLines.credit,
          lineOrder: journalLines.lineOrder,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalLines.accountId, apAccountId),
            eq(journalEntries.status, "POSTED"),
            eq(journalEntries.sourceType, "purchase_bill"),
            inArray(journalEntries.sourceId, billIds),
          ),
        )
        .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id), asc(journalLines.lineOrder));

      let running = 0;
      for (const row of journalRows) {
        const debit = Number(row.debit ?? 0);
        const credit = Number(row.credit ?? 0);
        running += credit - debit;
        const billNumber = row.sourceId ? billNumberById.get(row.sourceId) ?? null : null;
        const billIdNum = row.sourceId ? Number(row.sourceId) : null;
        lines.push({
          date: row.date,
          entryId: row.entryId,
          entryNumber: row.entryNumber,
          sourceType: row.sourceType,
          sourceEvent: row.sourceEvent,
          description: row.description,
          billId: billIdNum !== null && Number.isFinite(billIdNum) ? billIdNum : null,
          billNumber,
          debit: debit.toFixed(2),
          credit: credit.toFixed(2),
          runningBalance: running.toFixed(2),
        });
      }
    }

    return {
      summary: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        state: vendor.state,
        gstin: vendor.gstin,
        totalBilled: totalBilled.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        outstanding: (totalBilled - totalPaid).toFixed(2),
      },
      lines,
    };
  }

  async agedPayables(orgId: string, query: AgedReceivablesQuery) {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(`${asOf}T23:59:59.999Z`);

    const bills = await this.db
      .select({
        id: purchaseBills.id,
        vendorId: purchaseBills.vendorId,
        vendorName: clients.name,
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
        dueDate: purchaseBills.dueDate,
        billDate: purchaseBills.billDate,
      })
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(eq(purchaseBills.orgId, orgId), inArray(purchaseBills.status, [...OUTSTANDING_BILL_STATUSES])));

    const byVendor = new Map<number, AgedPayablesRow>();
    for (const bill of bills) {
      if (bill.vendorId === null) continue;
      const total = Number(bill.total ?? 0);
      const paid = Number(bill.amountPaid ?? 0);
      const outstanding = total - paid;
      if (outstanding <= 0.005) continue;

      const referenceDate = bill.dueDate
        ? new Date(`${bill.dueDate}T23:59:59.999Z`)
        : new Date(`${bill.billDate}T23:59:59.999Z`);
      const bucket = bucketFor(daysBetween(referenceDate, asOfDate));

      const existing = byVendor.get(bill.vendorId) ?? {
        vendorId: bill.vendorId,
        vendorName: bill.vendorName ?? `Vendor #${bill.vendorId}`,
        current: "0",
        d1_30: "0",
        d31_60: "0",
        d61_90: "0",
        d91_plus: "0",
        total: "0",
      };

      const updated: AgedPayablesRow = { ...existing };
      updated[bucket] = (Number(existing[bucket]) + outstanding).toFixed(2);
      updated.total = (Number(existing.total) + outstanding).toFixed(2);
      byVendor.set(bill.vendorId, updated);
    }

    const rows = Array.from(byVendor.values()).sort((a, b) => Number(b.total) - Number(a.total));
    const totals = rows.reduce(
      (acc, row) => {
        acc.current += Number(row.current);
        acc.d1_30 += Number(row.d1_30);
        acc.d31_60 += Number(row.d31_60);
        acc.d61_90 += Number(row.d61_90);
        acc.d91_plus += Number(row.d91_plus);
        acc.total += Number(row.total);
        return acc;
      },
      { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0, total: 0 },
    );

    return {
      asOf,
      rows,
      totals: {
        current: totals.current.toFixed(2),
        d1_30: totals.d1_30.toFixed(2),
        d31_60: totals.d31_60.toFixed(2),
        d61_90: totals.d61_90.toFixed(2),
        d91_plus: totals.d91_plus.toFixed(2),
        total: totals.total.toFixed(2),
      },
    };
  }
}
