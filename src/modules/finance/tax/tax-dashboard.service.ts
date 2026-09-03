import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql, sum } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { invoices, invoiceItems, purchaseBills, purchaseBillItems } from "../../../db/schema/crm/invoicing";
import { journalLines } from "../../../db/schema/accounting/accounting";
import { accTaxPayments } from "../../../db/schema/accounting/finance-tax";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { baseCreditAmount, baseDebitAmount } from "../../accounting/core/journal-base-amount";
import type { TaxDashboardQuery } from "./dto/tax-reports.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

const INVOICE_POSTED = ["ISSUED", "PAID", "FAILED"] as const;
const BILL_POSTED = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;

interface RateBucket {
  rate: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  count: number;
}

interface TaxRateGroup {
  rate: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  docCount: number;
}

@Injectable()
export class TaxDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly posting: FinancePostingService,
  ) {}

  async getDashboard(orgId: string, query: TaxDashboardQuery) {
    const cacheKey = `${query.from}:${query.to}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxDashboardNamespace(orgId), cacheKey, () => this.computeDashboard(orgId, query), 120);
  }

  private async computeDashboard(orgId: string, query: TaxDashboardQuery) {
    const { from, to } = query;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const [outputByRate, inputByRate, recentPayments, taxPayableBalance, taxReceivableBalance] = await Promise.all([
      this.getOutputTaxByRate(orgId, fromDate, toDate),
      this.getInputTaxByRate(orgId, from, to),
      this.getRecentPayments(orgId),
      this.getTaxAccountBalance(orgId, "TAX_PAYABLE"),
      this.getTaxAccountBalance(orgId, "TAX_RECEIVABLE"),
    ]);

    const totalOutputTax = outputByRate.reduce((acc, r) => acc + Number(r.cgst) + Number(r.sgst) + Number(r.igst), 0);
    const totalInputTax = inputByRate.reduce((acc, r) => acc + Number(r.cgst) + Number(r.sgst) + Number(r.igst), 0);
    const netLiability = Math.max(0, totalOutputTax - totalInputTax);
    const unpaidLiability = Math.max(0, taxPayableBalance - taxReceivableBalance);

    const nextDue = this.computeNextDueDates(to);

    return {
      period: { from, to },
      outputTaxByRate: outputByRate,
      inputTaxByRate: inputByRate,
      summary: {
        totalOutputTax: totalOutputTax.toFixed(4),
        totalInputTax: totalInputTax.toFixed(4),
        netLiability: netLiability.toFixed(4),
        unpaidLiability: unpaidLiability.toFixed(4),
        taxPayableBalance: taxPayableBalance.toFixed(4),
        taxReceivableBalance: taxReceivableBalance.toFixed(4),
      },
      recentPayments,
      nextDue,
    };
  }

  private async getOutputTaxByRate(orgId: string, fromDate: Date, toDate: Date): Promise<TaxRateGroup[]> {
    const invRows = await this.db
      .select({
        id: invoices.id,
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

    if (invRows.length === 0) return [];

    const invoiceIds = invRows.map((r) => r.id);
    const itemRows = await this.db
      .select({ invoiceId: invoiceItems.invoiceId, gstRate: invoiceItems.gstRate, amount: invoiceItems.amount })
      .from(invoiceItems)
      .where(inArray(invoiceItems.invoiceId, invoiceIds));

    const invoiceMap = new Map(invRows.map((r) => [r.id, r]));
    const buckets = new Map<string, RateBucket>();

    for (const item of itemRows) {
      const rateKey = Number(item.gstRate).toFixed(2);
      const inv = invoiceMap.get(item.invoiceId);
      if (!inv) continue;

      let bucket = buckets.get(rateKey);
      if (!bucket) {
        bucket = { rate: rateKey, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };
        buckets.set(rateKey, bucket);
      }

      bucket.taxableValue += Number(item.amount);
      bucket.count += 1;
    }

    const invCgstTotal = invRows.reduce((a, r) => a + Number(r.cgstAmount), 0);
    const invSgstTotal = invRows.reduce((a, r) => a + Number(r.sgstAmount), 0);
    const invIgstTotal = invRows.reduce((a, r) => a + Number(r.igstAmount), 0);

    const allTaxable = Array.from(buckets.values()).reduce((a, b) => a + b.taxableValue, 0);

    for (const bucket of buckets.values()) {
      const ratio = allTaxable > 0 ? bucket.taxableValue / allTaxable : 0;
      bucket.cgst = invCgstTotal * ratio;
      bucket.sgst = invSgstTotal * ratio;
      bucket.igst = invIgstTotal * ratio;
    }

    return Array.from(buckets.values())
      .sort((a, b) => Number(a.rate) - Number(b.rate))
      .map((b) => ({
        rate: b.rate,
        taxableValue: b.taxableValue.toFixed(4),
        cgst: b.cgst.toFixed(4),
        sgst: b.sgst.toFixed(4),
        igst: b.igst.toFixed(4),
        total: (b.cgst + b.sgst + b.igst).toFixed(4),
        docCount: b.count,
      }));
  }

  private async getInputTaxByRate(orgId: string, from: string, to: string): Promise<TaxRateGroup[]> {
    const billRows = await this.db
      .select({
        id: purchaseBills.id,
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

    if (billRows.length === 0) return [];

    const billIds = billRows.map((r) => r.id);
    const itemRows = await this.db
      .select({ billId: purchaseBillItems.billId, gstRate: purchaseBillItems.gstRate, amount: purchaseBillItems.amount })
      .from(purchaseBillItems)
      .where(inArray(purchaseBillItems.billId, billIds));

    const billMap = new Map(billRows.map((r) => [r.id, r]));
    const buckets = new Map<string, RateBucket>();

    for (const item of itemRows) {
      const rateKey = Number(item.gstRate).toFixed(2);
      const bill = billMap.get(item.billId);
      if (!bill) continue;

      let bucket = buckets.get(rateKey);
      if (!bucket) {
        bucket = { rate: rateKey, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };
        buckets.set(rateKey, bucket);
      }

      bucket.taxableValue += Number(item.amount);
      bucket.count += 1;
    }

    const billCgstTotal = billRows.reduce((a, r) => a + Number(r.cgstAmount), 0);
    const billSgstTotal = billRows.reduce((a, r) => a + Number(r.sgstAmount), 0);
    const billIgstTotal = billRows.reduce((a, r) => a + Number(r.igstAmount), 0);
    const allTaxable = Array.from(buckets.values()).reduce((a, b) => a + b.taxableValue, 0);

    for (const bucket of buckets.values()) {
      const ratio = allTaxable > 0 ? bucket.taxableValue / allTaxable : 0;
      bucket.cgst = billCgstTotal * ratio;
      bucket.sgst = billSgstTotal * ratio;
      bucket.igst = billIgstTotal * ratio;
    }

    return Array.from(buckets.values())
      .sort((a, b) => Number(a.rate) - Number(b.rate))
      .map((b) => ({
        rate: b.rate,
        taxableValue: b.taxableValue.toFixed(4),
        cgst: b.cgst.toFixed(4),
        sgst: b.sgst.toFixed(4),
        igst: b.igst.toFixed(4),
        total: (b.cgst + b.sgst + b.igst).toFixed(4),
        docCount: b.count,
      }));
  }

  private async getTaxAccountBalance(orgId: string, purpose: "TAX_PAYABLE" | "TAX_RECEIVABLE"): Promise<number> {
    try {
      const accountId = await this.posting.resolveSystemAccount(orgId, purpose);
      const rows = await this.db
        .select({
          totalDebit: sum(baseDebitAmount),
          totalCredit: sum(baseCreditAmount),
        })
        .from(journalLines)
        .where(and(eq(journalLines.orgId, orgId), eq(journalLines.accountId, accountId)));

      const row = rows[0];
      const debit = Number(row?.totalDebit ?? 0);
      const credit = Number(row?.totalCredit ?? 0);
      return purpose === "TAX_PAYABLE" ? credit - debit : debit - credit;
    } catch (err: unknown) {
      logSideEffectFailure("tax account balance lookup", { orgId, purpose })(err);
      return 0;
    }
  }

  private async getRecentPayments(orgId: string) {
    const rows = await this.db
      .select({
        id: accTaxPayments.id,
        taxType: accTaxPayments.taxType,
        amount: accTaxPayments.amount,
        paidDate: accTaxPayments.paidDate,
        reference: accTaxPayments.reference,
        periodStart: accTaxPayments.periodStart,
        periodEnd: accTaxPayments.periodEnd,
      })
      .from(accTaxPayments)
      .where(and(eq(accTaxPayments.orgId, orgId), isNull(accTaxPayments.archivedAt)))
      .orderBy(sql`${accTaxPayments.createdAt} DESC`)
      .limit(5);
    return rows;
  }

  private computeNextDueDates(periodEnd: string): { gstr1: string; gstr3b: string } {
    const d = new Date(periodEnd);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const year = nextMonth.getFullYear();
    const month = String(nextMonth.getMonth() + 1).padStart(2, "0");
    return {
      gstr1: `${year}-${month}-11`,
      gstr3b: `${year}-${month}-20`,
    };
  }
}
