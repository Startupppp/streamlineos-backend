import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, sql } from "drizzle-orm";
import {
  clients,
  ledgerAccounts,
  journalEntries,
  journalLines,
  purchaseBills,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import type { AgedPayablesRow, VendorLedgerLine } from "./accounting.types";
import type { AgedReceivablesQuery, ListVendorsQuery } from "./dto/accounting.schemas";
import { addDecimals, compareDecimals, roundDecimal, subtractDecimals, sumDecimals, toDecimal } from "./money.util";

const AP_ACCOUNT_CODE = "2000";
const OUTSTANDING_BILL_STATUSES = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;
const OUTSTANDING_EPSILON = 0.005;

type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d91_plus";

interface ExactAging {
  vendorId: number;
  vendorName: string;
  amounts: Record<Bucket, string>;
  total: string;
}

function emptyAmounts(): Record<Bucket, string> {
  return { current: "0", d1_30: "0", d31_60: "0", d61_90: "0", d91_plus: "0" };
}

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%");
}

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d91_plus";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

@Injectable()
export class AccountingVendorQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listVendors(orgId: string, query: ListVendorsQuery) {
    const { cursor, limit, q, onlyOutstanding } = query;
    const conds = [eq(clients.orgId, orgId), eq(clients.isVendor, true)];
    if (q) conds.push(ilike(clients.name, `%${escapeLike(q)}%`));
    const pos = decodeCursor(cursor);
    if (pos) conds.push(keysetAfterValue(clients.name, clients.id, pos));

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

    const rows = await listQuery.orderBy(asc(clients.name), asc(clients.id)).limit(limit + 1);

    const items = rows.map((r) => ({
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      state: r.state,
      gstin: r.gstin,
      billCount: Number(r.billCount ?? 0),
      outstanding: roundDecimal(subtractDecimals(toDecimal(r.totalBilled), toDecimal(r.totalPaid)), 2),
    }));

    return buildCursorPage(items, limit, (r) => ({ sortValue: r.vendorName ?? "", id: String(r.vendorId) }));
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
    const totalBilled = sumDecimals(billRows.map((b) => b.total));
    const totalPaid = sumDecimals(billRows.map((b) => b.amountPaid));

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

      let running = "0";
      for (const row of journalRows) {
        const debit = toDecimal(row.debit);
        const credit = toDecimal(row.credit);
        running = addDecimals(running, subtractDecimals(credit, debit));
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
          debit: roundDecimal(debit, 2),
          credit: roundDecimal(credit, 2),
          runningBalance: roundDecimal(running, 2),
        });
      }
    }

    return {
      summary: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        state: vendor.state,
        gstin: vendor.gstin,
        totalBilled: roundDecimal(totalBilled, 2),
        totalPaid: roundDecimal(totalPaid, 2),
        outstanding: roundDecimal(subtractDecimals(totalBilled, totalPaid), 2),
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
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          inArray(purchaseBills.status, [...OUTSTANDING_BILL_STATUSES]),
          sql`${purchaseBills.vendorId} is not null`,
          sql`${purchaseBills.total} - ${purchaseBills.amountPaid} > ${OUTSTANDING_EPSILON}`,
        ),
      );

    const byVendor = new Map<number, ExactAging>();
    for (const bill of bills) {
      if (bill.vendorId === null) continue;
      const outstanding = subtractDecimals(toDecimal(bill.total), toDecimal(bill.amountPaid));

      const referenceDate = bill.dueDate
        ? new Date(`${bill.dueDate}T23:59:59.999Z`)
        : new Date(`${bill.billDate}T23:59:59.999Z`);
      const bucket = bucketFor(daysBetween(referenceDate, asOfDate));

      const existing = byVendor.get(bill.vendorId) ?? {
        vendorId: bill.vendorId,
        vendorName: bill.vendorName ?? `Vendor #${bill.vendorId}`,
        amounts: emptyAmounts(),
        total: "0",
      };
      existing.amounts[bucket] = addDecimals(existing.amounts[bucket], outstanding);
      existing.total = addDecimals(existing.total, outstanding);
      byVendor.set(bill.vendorId, existing);
    }

    const exact = Array.from(byVendor.values()).sort((a, b) => compareDecimals(b.total, a.total));
    const rows: AgedPayablesRow[] = exact.map((entry) => ({
      vendorId: entry.vendorId,
      vendorName: entry.vendorName,
      current: roundDecimal(entry.amounts.current, 2),
      d1_30: roundDecimal(entry.amounts.d1_30, 2),
      d31_60: roundDecimal(entry.amounts.d31_60, 2),
      d61_90: roundDecimal(entry.amounts.d61_90, 2),
      d91_plus: roundDecimal(entry.amounts.d91_plus, 2),
      total: roundDecimal(entry.total, 2),
    }));

    const totalFor = (bucket: Bucket): string =>
      roundDecimal(sumDecimals(exact.map((entry) => entry.amounts[bucket])), 2);

    return {
      asOf,
      rows,
      totals: {
        current: totalFor("current"),
        d1_30: totalFor("d1_30"),
        d31_60: totalFor("d31_60"),
        d61_90: totalFor("d61_90"),
        d91_plus: totalFor("d91_plus"),
        total: roundDecimal(sumDecimals(exact.map((entry) => entry.total)), 2),
      },
    };
  }
}
