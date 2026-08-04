import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { invoices, invoiceItems, purchaseBills, purchaseBillItems } from "../../../db/schema/crm/invoicing";
import { clients } from "../../../db/schema/crm/contacts";
import { journalLines } from "../../../db/schema/accounting/accounting";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { FinancePostingService } from "../../accounting/core/finance-posting.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { TaxDateRangeQuery } from "./dto/tax-reports.schemas";

const INVOICE_POSTED = ["ISSUED", "PAID", "FAILED"] as const;
const BILL_POSTED = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

export interface OutputTaxLine {
  sourceType: string;
  sourceId: number;
  docNumber: string;
  date: string;
  partyName: string;
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
}

export interface InputTaxLine {
  sourceType: string;
  sourceId: number;
  docNumber: string;
  date: string;
  partyName: string;
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
}

interface MonthBucket {
  month: string;
  outputTax: number;
  inputTax: number;
}

@Injectable()
export class TaxReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly posting: FinancePostingService,
  ) {}

  async getOutputReport(orgId: string, query: TaxDateRangeQuery) {
    const cacheKey = `output:${query.from}:${query.to}:${query.rate ?? ""}:${query.page}:${query.pageSize}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxReportsNamespace(orgId), cacheKey, () => this.computeOutputReport(orgId, query), 120);
  }

  async getInputReport(orgId: string, query: TaxDateRangeQuery) {
    const cacheKey = `input:${query.from}:${query.to}:${query.rate ?? ""}:${query.page}:${query.pageSize}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxReportsNamespace(orgId), cacheKey, () => this.computeInputReport(orgId, query), 120);
  }

  async getLiabilitySummary(orgId: string, query: TaxDateRangeQuery) {
    const cacheKey = `liability:${query.from}:${query.to}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxReportsNamespace(orgId), cacheKey, () => this.computeLiabilitySummary(orgId, query), 120);
  }

  private async computeOutputReport(orgId: string, query: TaxDateRangeQuery) {
    const { from, to, page, pageSize } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);
    const { limit, offset } = paginateOffset({ page, pageSize });

    const invConditions = [
      eq(invoices.orgId, orgId),
      inArray(invoices.status, [...INVOICE_POSTED]),
      gte(invoices.createdAt, fromDate),
      lte(invoices.createdAt, toDate),
    ];

    const [invRows, [{ total: invTotal }]] = await Promise.all([
      this.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          createdAt: invoices.createdAt,
          cgstAmount: invoices.cgstAmount,
          sgstAmount: invoices.sgstAmount,
          igstAmount: invoices.igstAmount,
          clientId: invoices.clientId,
        })
        .from(invoices)
        .where(and(...invConditions))
        .orderBy(sql`${invoices.createdAt} DESC`)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(invoices).where(and(...invConditions)),
    ]);

    if (invRows.length === 0) {
      return buildListResponse<OutputTaxLine>([], Number(invTotal ?? 0), { page, pageSize });
    }

    const invoiceIds = invRows.map((r) => r.id);
    const clientIds = invRows.map((r) => r.clientId).filter((id): id is number => id !== null);

    const [itemRows, clientRows] = await Promise.all([
      this.db
        .select({ invoiceId: invoiceItems.invoiceId, gstRate: invoiceItems.gstRate, amount: invoiceItems.amount })
        .from(invoiceItems)
        .where(inArray(invoiceItems.invoiceId, invoiceIds)),
      clientIds.length > 0
        ? this.db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, clientIds))
        : Promise.resolve([] as { id: number; name: string }[]),
    ]);

    const clientMap = new Map(clientRows.map((c) => [c.id, c.name]));
    const itemsByInvoice = new Map<number, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsByInvoice.get(item.invoiceId) ?? [];
      list.push(item);
      itemsByInvoice.set(item.invoiceId, list);
    }

    const lines: OutputTaxLine[] = [];
    for (const inv of invRows) {
      const items = itemsByInvoice.get(inv.id) ?? [];
      const rateFilter = query.rate !== undefined ? query.rate.toFixed(2) : null;

      const rateGroups = new Map<string, number>();
      for (const item of items) {
        const rateKey = Number(item.gstRate).toFixed(2);
        if (rateFilter && rateKey !== rateFilter) continue;
        rateGroups.set(rateKey, (rateGroups.get(rateKey) ?? 0) + Number(item.amount));
      }

      const totalTaxable = Array.from(rateGroups.values()).reduce((a, b) => a + b, 0);
      const invCgst = Number(inv.cgstAmount);
      const invSgst = Number(inv.sgstAmount);
      const invIgst = Number(inv.igstAmount);

      for (const [rate, taxable] of rateGroups.entries()) {
        const ratio = totalTaxable > 0 ? taxable / totalTaxable : 0;
        const cgst = invCgst * ratio;
        const sgst = invSgst * ratio;
        const igst = invIgst * ratio;

        lines.push({
          sourceType: "invoice",
          sourceId: inv.id,
          docNumber: inv.invoiceNumber,
          date: inv.createdAt.toISOString().slice(0, 10),
          partyName: inv.clientId ? (clientMap.get(inv.clientId) ?? "Unknown") : "Unknown",
          taxableValue: taxable.toFixed(4),
          gstRate: rate,
          cgst: cgst.toFixed(4),
          sgst: sgst.toFixed(4),
          igst: igst.toFixed(4),
          total: (cgst + sgst + igst).toFixed(4),
        });
      }
    }

    return buildListResponse<OutputTaxLine>(lines, Number(invTotal ?? 0), { page, pageSize });
  }

  private async computeInputReport(orgId: string, query: TaxDateRangeQuery) {
    const { from, to, page, pageSize } = query;
    const { limit, offset } = paginateOffset({ page, pageSize });

    const billConditions = [
      eq(purchaseBills.orgId, orgId),
      inArray(purchaseBills.status, [...BILL_POSTED]),
      gte(purchaseBills.billDate, from),
      lte(purchaseBills.billDate, to),
    ];

    const [billRows, [{ total: billTotal }]] = await Promise.all([
      this.db
        .select({
          id: purchaseBills.id,
          billNumber: purchaseBills.billNumber,
          billDate: purchaseBills.billDate,
          cgstAmount: purchaseBills.cgstAmount,
          sgstAmount: purchaseBills.sgstAmount,
          igstAmount: purchaseBills.igstAmount,
          vendorId: purchaseBills.vendorId,
        })
        .from(purchaseBills)
        .where(and(...billConditions))
        .orderBy(sql`${purchaseBills.billDate} DESC`)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(purchaseBills).where(and(...billConditions)),
    ]);

    if (billRows.length === 0) {
      return buildListResponse<InputTaxLine>([], Number(billTotal ?? 0), { page, pageSize });
    }

    const billIds = billRows.map((r) => r.id);
    const vendorIds = billRows.map((r) => r.vendorId).filter((id): id is number => id !== null);

    const [itemRows, vendorRows] = await Promise.all([
      this.db
        .select({ billId: purchaseBillItems.billId, gstRate: purchaseBillItems.gstRate, amount: purchaseBillItems.amount })
        .from(purchaseBillItems)
        .where(inArray(purchaseBillItems.billId, billIds)),
      vendorIds.length > 0
        ? this.db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, vendorIds))
        : Promise.resolve([] as { id: number; name: string }[]),
    ]);

    const vendorMap = new Map(vendorRows.map((v) => [v.id, v.name]));
    const itemsByBill = new Map<number, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsByBill.get(item.billId) ?? [];
      list.push(item);
      itemsByBill.set(item.billId, list);
    }

    const lines: InputTaxLine[] = [];
    for (const bill of billRows) {
      const items = itemsByBill.get(bill.id) ?? [];
      const rateFilter = query.rate !== undefined ? query.rate.toFixed(2) : null;

      const rateGroups = new Map<string, number>();
      for (const item of items) {
        const rateKey = Number(item.gstRate).toFixed(2);
        if (rateFilter && rateKey !== rateFilter) continue;
        rateGroups.set(rateKey, (rateGroups.get(rateKey) ?? 0) + Number(item.amount));
      }

      const totalTaxable = Array.from(rateGroups.values()).reduce((a, b) => a + b, 0);
      const billCgst = Number(bill.cgstAmount);
      const billSgst = Number(bill.sgstAmount);
      const billIgst = Number(bill.igstAmount);

      for (const [rate, taxable] of rateGroups.entries()) {
        const ratio = totalTaxable > 0 ? taxable / totalTaxable : 0;
        const cgst = billCgst * ratio;
        const sgst = billSgst * ratio;
        const igst = billIgst * ratio;

        lines.push({
          sourceType: "purchase_bill",
          sourceId: bill.id,
          docNumber: bill.billNumber,
          date: bill.billDate,
          partyName: bill.vendorId ? (vendorMap.get(bill.vendorId) ?? "Unknown") : "Unknown",
          taxableValue: taxable.toFixed(4),
          gstRate: rate,
          cgst: cgst.toFixed(4),
          sgst: sgst.toFixed(4),
          igst: igst.toFixed(4),
          total: (cgst + sgst + igst).toFixed(4),
        });
      }
    }

    return buildListResponse<InputTaxLine>(lines, Number(billTotal ?? 0), { page, pageSize });
  }

  private async computeLiabilitySummary(orgId: string, query: TaxDateRangeQuery) {
    const { from, to } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const invRows = await this.db
      .select({
        createdAt: invoices.createdAt,
        cgstAmount: invoices.cgstAmount,
        sgstAmount: invoices.sgstAmount,
        igstAmount: invoices.igstAmount,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, [...INVOICE_POSTED]),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      );

    const billRows = await this.db
      .select({
        billDate: purchaseBills.billDate,
        cgstAmount: purchaseBills.cgstAmount,
        sgstAmount: purchaseBills.sgstAmount,
        igstAmount: purchaseBills.igstAmount,
      })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          inArray(purchaseBills.status, [...BILL_POSTED]),
          gte(purchaseBills.billDate, from),
          lte(purchaseBills.billDate, to),
        ),
      );

    const outputByMonth = new Map<string, MonthBucket>();
    for (const inv of invRows) {
      const month = inv.createdAt.toISOString().slice(0, 7);
      let b = outputByMonth.get(month);
      if (!b) {
        b = { month, outputTax: 0, inputTax: 0 };
        outputByMonth.set(month, b);
      }
      b.outputTax += Number(inv.cgstAmount) + Number(inv.sgstAmount) + Number(inv.igstAmount);
    }

    for (const bill of billRows) {
      const month = bill.billDate.slice(0, 7);
      let b = outputByMonth.get(month);
      if (!b) {
        b = { month, outputTax: 0, inputTax: 0 };
        outputByMonth.set(month, b);
      }
      b.inputTax += Number(bill.cgstAmount) + Number(bill.sgstAmount) + Number(bill.igstAmount);
    }

    let cumulative = 0;
    const months = Array.from(outputByMonth.values()).sort((a, b) => a.month.localeCompare(b.month));

    let taxPayableBalance: number;
    try {
      const accountId = await this.posting.resolveSystemAccount(orgId, "TAX_PAYABLE");
      const rows = await this.db
        .select({ totalDebit: sql<string>`sum(${journalLines.debit})`, totalCredit: sql<string>`sum(${journalLines.credit})` })
        .from(journalLines)
        .where(and(eq(journalLines.orgId, orgId), eq(journalLines.accountId, accountId)));
      const row = rows[0];
      const debit = Number(row?.totalDebit ?? 0);
      const credit = Number(row?.totalCredit ?? 0);
      taxPayableBalance = credit - debit;
    } catch {
      taxPayableBalance = 0;
    }

    const buckets = months.map((m) => {
      const net = m.outputTax - m.inputTax;
      cumulative += net;
      return {
        month: m.month,
        outputTax: m.outputTax.toFixed(4),
        inputTax: m.inputTax.toFixed(4),
        netLiability: net.toFixed(4),
        cumulativeUnpaid: cumulative.toFixed(4),
      };
    });

    return {
      period: { from, to },
      months: buckets,
      totalOutputTax: months.reduce((a, b) => a + b.outputTax, 0).toFixed(4),
      totalInputTax: months.reduce((a, b) => a + b.inputTax, 0).toFixed(4),
      totalNetLiability: cumulative.toFixed(4),
      taxPayableBalance: taxPayableBalance.toFixed(4),
    };
  }
}
