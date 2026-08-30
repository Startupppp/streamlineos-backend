import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, ilike, inArray, lt, sql } from "drizzle-orm";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import {
  clients,
  ledgerAccounts,
  journalEntries,
  journalLines,
  purchaseBills,
  purchaseBillItems,
  vendorPayments,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { AgedPayablesRow, VendorLedgerLine } from "./accounting.types";
import type {
  AgedReceivablesQuery,
  ListCustomersOutstandingQuery,
  ListPurchaseBillsQuery,
} from "./dto/accounting.schemas";

const AP_ACCOUNT_CODE = "2000";
const OUTSTANDING_BILL_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

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
export class AccountingPayablesQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPurchaseBills(orgId: string, query: ListPurchaseBillsQuery, scope: DataScope, userId: string) {
    const { cursor, limit, q, status, vendorId } = query;
    const conds = [eq(purchaseBills.orgId, orgId)];
    if (status) {
      if (Array.isArray(status)) {
        conds.push(inArray(purchaseBills.status, status));
      } else {
        conds.push(eq(purchaseBills.status, status));
      }
    }
    if (vendorId) conds.push(eq(purchaseBills.vendorId, vendorId));
    if (q) conds.push(ilike(purchaseBills.billNumber, `%${escapeLike(q)}%`));
    conds.push(applyScope(scope, orgId, userId, { ownerColumn: purchaseBills.createdBy }));
    if (cursor) conds.push(lt(purchaseBills.id, cursor));

    const rows = await this.db
      .select(BILL_COLUMNS)
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(...conds))
      .orderBy(desc(purchaseBills.id))
      .limit(limit + 1);

    return buildIdCursorPage(rows, limit, (row) => row.id);
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
      .select({
        id: purchaseBillItems.id,
        billId: purchaseBillItems.billId,
        description: purchaseBillItems.description,
        hsnSacCode: purchaseBillItems.hsnSacCode,
        quantity: purchaseBillItems.quantity,
        rate: purchaseBillItems.rate,
        gstRate: purchaseBillItems.gstRate,
        amount: purchaseBillItems.amount,
        lineOrder: purchaseBillItems.lineOrder,
      })
      .from(purchaseBillItems)
      .where(eq(purchaseBillItems.billId, billId))
      .orderBy(asc(purchaseBillItems.lineOrder));

    return { ...header, items };
  }

  async listBillPayments(orgId: string, billId: number) {
    const bills = await this.db
      .select({ id: purchaseBills.id })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    if (!bills[0]) throw new NotFoundException("Purchase bill not found");

    return this.db
      .select({
        id: vendorPayments.id,
        orgId: vendorPayments.orgId,
        billId: vendorPayments.billId,
        amount: vendorPayments.amount,
        paymentDate: vendorPayments.paymentDate,
        paymentMethod: vendorPayments.paymentMethod,
        referenceNumber: vendorPayments.referenceNumber,
        notes: vendorPayments.notes,
        createdBy: vendorPayments.createdBy,
        createdAt: vendorPayments.createdAt,
      })
      .from(vendorPayments)
      .where(and(eq(vendorPayments.billId, billId), eq(vendorPayments.orgId, orgId)))
      .orderBy(asc(vendorPayments.paymentDate), asc(vendorPayments.id))
      .limit(100);
  }

  async listVendors(orgId: string, query: ListCustomersOutstandingQuery) {
    const { cursor, limit, q, onlyOutstanding } = query;
    const conds = [eq(clients.orgId, orgId), eq(clients.isVendor, true)];
    if (q) conds.push(ilike(clients.name, `%${escapeLike(q)}%`));
    if (cursor) conds.push(gt(clients.id, cursor));

    const billStatusIn = sql`${purchaseBills.status} IN ('POSTED','PARTIALLY_PAID','PAID')`;
    const totalBilledExpr = sql<string>`COALESCE(SUM(${purchaseBills.total}::numeric) FILTER (WHERE ${billStatusIn}), 0)::text`;
    const totalPaidExpr = sql<string>`COALESCE(SUM(${purchaseBills.amountPaid}::numeric) FILTER (WHERE ${billStatusIn}), 0)::text`;
    const outstandingExpr = sql<string>`(COALESCE(SUM(${purchaseBills.total}::numeric) FILTER (WHERE ${billStatusIn}), 0) - COALESCE(SUM(${purchaseBills.amountPaid}::numeric) FILTER (WHERE ${billStatusIn}), 0))::text`;

    let listQuery = this.db
      .select({
        vendorId: clients.id,
        vendorName: clients.name,
        state: clients.state,
        gstin: clients.gstin,
        billCount: sql<number>`COUNT(${purchaseBills.id}) FILTER (WHERE ${billStatusIn})::int`,
        totalBilled: totalBilledExpr,
        totalPaid: totalPaidExpr,
      })
      .from(clients)
      .leftJoin(purchaseBills, and(eq(purchaseBills.vendorId, clients.id), eq(purchaseBills.orgId, orgId)))
      .where(and(...conds))
      .groupBy(clients.id, clients.name, clients.state, clients.gstin)
      .$dynamic();
    if (onlyOutstanding) listQuery = listQuery.having(gt(outstandingExpr, "0"));

    const rows = await listQuery.orderBy(asc(clients.id)).limit(limit + 1);

    const items = rows.map((r) => ({
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      state: r.state,
      gstin: r.gstin,
      billCount: Number(r.billCount ?? 0),
      outstanding: (Number(r.totalBilled ?? 0) - Number(r.totalPaid ?? 0)).toFixed(2),
    }));

    return buildIdCursorPage(items, limit, (item) => item.vendorId);
  }

  async vendorLedger(orgId: string, vendorId: number) {
    const vendorRows = await this.db
      .select({ id: clients.id, name: clients.name, state: clients.state, gstin: clients.gstin })
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
