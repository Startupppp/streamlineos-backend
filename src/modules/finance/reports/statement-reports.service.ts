import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sql, sum, count } from "drizzle-orm";
import {
  clients,
  invoices,
  purchaseBills,
  vendorPayments,
  payments,
  vendorCredits,
  expenseCategories,
  expenses,
  invoiceItems,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";

interface StatementLine {
  date: string;
  docType: string;
  docNumber: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

@Injectable()
export class StatementReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async vendorStatement(orgId: string, vendorId: number, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `vendor-stmt:${vendorId}:${from}:${to}`,
      () => this.computeVendorStatement(orgId, vendorId, from, to),
      120,
    );
  }

  private async computeVendorStatement(orgId: string, vendorId: number, from: string, to: string) {
    const vendorRows = await this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, vendorId), eq(clients.orgId, orgId)))
      .limit(1);
    if (!vendorRows[0]) throw new NotFoundException("Vendor not found");
    const vendor = vendorRows[0];

    const openingBills = await this.db
      .select({ total: sum(purchaseBills.total), paid: sum(purchaseBills.amountPaid) })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          eq(purchaseBills.vendorId, vendorId),
          lte(purchaseBills.billDate, from),
          inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"]),
        ),
      );
    const openingBillAmt = Number(openingBills[0]?.total ?? 0);
    const openingPaidAmt = Number(openingBills[0]?.paid ?? 0);
    const openingBalance = openingBillAmt - openingPaidAmt;

    const [billRows, paymentRows, creditRows] = await Promise.all([
      this.db
        .select({
          id: purchaseBills.id,
          billNumber: purchaseBills.billNumber,
          billDate: purchaseBills.billDate,
          total: purchaseBills.total,
        })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            eq(purchaseBills.vendorId, vendorId),
            gte(purchaseBills.billDate, from),
            lte(purchaseBills.billDate, to),
            inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"]),
          ),
        )
        .orderBy(purchaseBills.billDate),

      this.db
        .select({
          id: vendorPayments.id,
          referenceNumber: vendorPayments.referenceNumber,
          paymentDate: vendorPayments.paymentDate,
          amount: vendorPayments.amount,
        })
        .from(vendorPayments)
        .innerJoin(purchaseBills, eq(purchaseBills.id, vendorPayments.billId))
        .where(
          and(
            eq(vendorPayments.orgId, orgId),
            eq(purchaseBills.vendorId, vendorId),
            gte(vendorPayments.paymentDate, from),
            lte(vendorPayments.paymentDate, to),
          ),
        )
        .orderBy(vendorPayments.paymentDate),

      this.db
        .select({
          id: vendorCredits.id,
          vendorCreditNumber: vendorCredits.vendorCreditNumber,
          createdAt: vendorCredits.createdAt,
          total: vendorCredits.total,
        })
        .from(vendorCredits)
        .where(
          and(
            eq(vendorCredits.orgId, orgId),
            eq(vendorCredits.vendorId, vendorId),
            inArray(vendorCredits.status, ["POSTED", "APPLIED"]),
            gte(sql`${vendorCredits.createdAt}::date`, from),
            lte(sql`${vendorCredits.createdAt}::date`, to),
          ),
        )
        .orderBy(vendorCredits.createdAt),
    ]);

    type RawLine = { date: string; docType: string; docNumber: string; debit: number; credit: number };
    const rawLines: RawLine[] = [];
    for (const b of billRows) {
      rawLines.push({ date: b.billDate, docType: "BILL", docNumber: b.billNumber, debit: Number(b.total ?? 0), credit: 0 });
    }
    for (const p of paymentRows) {
      rawLines.push({ date: p.paymentDate, docType: "PAYMENT", docNumber: p.referenceNumber ?? `VP-${p.id}`, debit: 0, credit: Number(p.amount ?? 0) });
    }
    for (const c of creditRows) {
      const d = new Date(c.createdAt).toISOString().slice(0, 10);
      rawLines.push({ date: d, docType: "CREDIT_NOTE", docNumber: c.vendorCreditNumber, debit: 0, credit: Number(c.total ?? 0) });
    }
    rawLines.sort((a, b) => a.date.localeCompare(b.date));

    let running = openingBalance;
    const lines: StatementLine[] = rawLines.map((l) => {
      running = running + l.debit - l.credit;
      return {
        date: l.date,
        docType: l.docType,
        docNumber: l.docNumber,
        debit: l.debit.toFixed(2),
        credit: l.credit.toFixed(2),
        runningBalance: running.toFixed(2),
      };
    });

    return {
      vendor: { id: vendor.id, name: vendor.name },
      openingBalance: openingBalance.toFixed(2),
      lines,
      closingBalance: running.toFixed(2),
    };
  }

  async customerStatement(orgId: string, clientId: number, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `customer-stmt:${clientId}:${from}:${to}`,
      () => this.computeCustomerStatement(orgId, clientId, from, to),
      120,
    );
  }

  private async computeCustomerStatement(orgId: string, clientId: number, from: string, to: string) {
    const clientRows = await this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)))
      .limit(1);
    if (!clientRows[0]) throw new NotFoundException("Client not found");
    const client = clientRows[0];

    const openingInv = await this.db
      .select({ total: sum(invoices.total), paid: sum(invoices.amountPaid) })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          eq(invoices.clientId, clientId),
          lte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
          inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
        ),
      );
    const openingBalance = Number(openingInv[0]?.total ?? 0) - Number(openingInv[0]?.paid ?? 0);

    const [invoiceRows, paymentRows] = await Promise.all([
      this.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          createdAt: invoices.createdAt,
          total: invoices.total,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, orgId),
            eq(invoices.clientId, clientId),
            inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
            gte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
            lte(invoices.createdAt, new Date(`${to}T23:59:59.000Z`)),
          ),
        )
        .orderBy(invoices.createdAt),

      this.db
        .select({
          id: payments.id,
          referenceNumber: payments.referenceNumber,
          paymentDate: payments.paymentDate,
          amount: payments.amount,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(payments.orgId, orgId),
            eq(invoices.clientId, clientId),
            gte(payments.paymentDate, from),
            lte(payments.paymentDate, to),
          ),
        )
        .orderBy(payments.paymentDate),
    ]);

    type RawLine = { date: string; docType: string; docNumber: string; debit: number; credit: number };
    const rawLines: RawLine[] = [];
    for (const inv of invoiceRows) {
      const d = new Date(inv.createdAt).toISOString().slice(0, 10);
      rawLines.push({ date: d, docType: "INVOICE", docNumber: inv.invoiceNumber, debit: Number(inv.total ?? 0), credit: 0 });
    }
    for (const p of paymentRows) {
      rawLines.push({ date: p.paymentDate, docType: "PAYMENT", docNumber: p.referenceNumber ?? `PMT-${p.id}`, debit: 0, credit: Number(p.amount ?? 0) });
    }
    rawLines.sort((a, b) => a.date.localeCompare(b.date));

    let running = openingBalance;
    const lines: StatementLine[] = rawLines.map((l) => {
      running = running + l.debit - l.credit;
      return {
        date: l.date,
        docType: l.docType,
        docNumber: l.docNumber,
        debit: l.debit.toFixed(2),
        credit: l.credit.toFixed(2),
        runningBalance: running.toFixed(2),
      };
    });

    return {
      client: { id: client.id, name: client.name },
      openingBalance: openingBalance.toFixed(2),
      lines,
      closingBalance: running.toFixed(2),
    };
  }

  async salesByCustomer(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `sales-by-customer:${from}:${to}`,
      () => this.computeSalesByCustomer(orgId, from, to),
      120,
    );
  }

  private async computeSalesByCustomer(orgId: string, from: string, to: string) {
    const rows = await this.db
      .select({
        clientId: invoices.clientId,
        clientName: clients.name,
        invoiceCount: count(invoices.id),
        totalBilled: sum(invoices.total),
        totalPaid: sum(invoices.amountPaid),
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
          gte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
          lte(invoices.createdAt, new Date(`${to}T23:59:59.000Z`)),
        ),
      )
      .groupBy(invoices.clientId, clients.name)
      .orderBy(sql`sum(${invoices.total}) desc`);

    return rows.map((r) => {
      const billed = Number(r.totalBilled ?? 0);
      const paid = Number(r.totalPaid ?? 0);
      return {
        clientId: r.clientId,
        clientName: r.clientName ?? "Unknown",
        invoiceCount: Number(r.invoiceCount ?? 0),
        totalBilled: billed.toFixed(2),
        totalPaid: paid.toFixed(2),
        outstanding: (billed - paid).toFixed(2),
      };
    });
  }

  async salesByItem(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `sales-by-item:${from}:${to}`,
      () => this.computeSalesByItem(orgId, from, to),
      120,
    );
  }

  private async computeSalesByItem(orgId: string, from: string, to: string) {
    const rows = await this.db
      .select({
        description: invoiceItems.description,
        totalQuantity: sum(invoiceItems.quantity),
        totalAmount: sum(invoiceItems.amount),
        invoiceCount: count(invoices.id),
      })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
          gte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
          lte(invoices.createdAt, new Date(`${to}T23:59:59.000Z`)),
        ),
      )
      .groupBy(invoiceItems.description)
      .orderBy(sql`sum(${invoiceItems.amount}) desc`);

    return rows.map((r) => ({
      description: r.description,
      totalQuantity: Number(r.totalQuantity ?? 0).toFixed(4),
      totalAmount: Number(r.totalAmount ?? 0).toFixed(2),
      invoiceCount: Number(r.invoiceCount ?? 0),
    }));
  }

  async expenseByCategory(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `expense-by-cat:${from}:${to}`,
      () => this.computeExpenseByCategory(orgId, from, to),
      120,
    );
  }

  private async computeExpenseByCategory(orgId: string, from: string, to: string) {
    const rows = await this.db
      .select({
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        totalAmount: sum(expenses.amount),
        cnt: count(expenses.id),
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(
        and(
          eq(expenses.orgId, orgId),
          inArray(expenses.status, ["APPROVED", "PAID"]),
          gte(expenses.expenseDate, from),
          lte(expenses.expenseDate, to),
        ),
      )
      .groupBy(expenses.categoryId, expenseCategories.name)
      .orderBy(sql`sum(${expenses.amount}) desc`);

    return rows.map((r) => ({
      categoryId: r.categoryId ?? null,
      categoryName: r.categoryName ?? "Uncategorized",
      totalAmount: Number(r.totalAmount ?? 0).toFixed(2),
      count: Number(r.cnt ?? 0),
    }));
  }

  async taxSummary(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `tax-summary:${from}:${to}`,
      () => this.computeTaxSummary(orgId, from, to),
      120,
    );
  }

  private async computeTaxSummary(orgId: string, from: string, to: string) {
    const [outputRows, inputRows] = await Promise.all([
      this.db
        .select({
          month: sql<string>`to_char(date_trunc('month', ${invoices.createdAt}::date), 'YYYY-MM')`,
          cgst: sum(invoices.cgstAmount),
          sgst: sum(invoices.sgstAmount),
          igst: sum(invoices.igstAmount),
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, orgId),
            inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
            gte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
            lte(invoices.createdAt, new Date(`${to}T23:59:59.000Z`)),
          ),
        )
        .groupBy(sql`date_trunc('month', ${invoices.createdAt}::date)`)
        .orderBy(sql`date_trunc('month', ${invoices.createdAt}::date)`),

      this.db
        .select({
          month: sql<string>`to_char(date_trunc('month', ${purchaseBills.billDate}::date), 'YYYY-MM')`,
          cgst: sum(purchaseBills.cgstAmount),
          sgst: sum(purchaseBills.sgstAmount),
          igst: sum(purchaseBills.igstAmount),
        })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"]),
            gte(purchaseBills.billDate, from),
            lte(purchaseBills.billDate, to),
          ),
        )
        .groupBy(sql`date_trunc('month', ${purchaseBills.billDate}::date)`)
        .orderBy(sql`date_trunc('month', ${purchaseBills.billDate}::date)`),
    ]);

    const allMonths = new Set<string>();
    for (const r of outputRows) if (r.month) allMonths.add(r.month);
    for (const r of inputRows) if (r.month) allMonths.add(r.month);

    const outputMap = new Map(outputRows.map((r) => [r.month ?? "", r]));
    const inputMap = new Map(inputRows.map((r) => [r.month ?? "", r]));

    return Array.from(allMonths)
      .sort()
      .map((month) => {
        const out = outputMap.get(month);
        const inp = inputMap.get(month);
        const outCgst = Number(out?.cgst ?? 0);
        const outSgst = Number(out?.sgst ?? 0);
        const outIgst = Number(out?.igst ?? 0);
        const inCgst = Number(inp?.cgst ?? 0);
        const inSgst = Number(inp?.sgst ?? 0);
        const inIgst = Number(inp?.igst ?? 0);
        const netPayable = outCgst + outSgst + outIgst - inCgst - inSgst - inIgst;
        return {
          month,
          outputCgst: outCgst.toFixed(2),
          outputSgst: outSgst.toFixed(2),
          outputIgst: outIgst.toFixed(2),
          inputCgst: inCgst.toFixed(2),
          inputSgst: inSgst.toFixed(2),
          inputIgst: inIgst.toFixed(2),
          netPayable: netPayable.toFixed(2),
        };
      });
  }
}
