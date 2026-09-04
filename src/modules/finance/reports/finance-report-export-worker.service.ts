import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { and, asc, count, eq, gte, inArray, isNotNull, lte, sql, sum } from "drizzle-orm";
import { forEachOrg } from "../../../common/tenant";
import { StorageService } from "../../storage/storage.service";
import { FinanceReportExportService, type FinanceReportExportJobRow, REPORT_LINE_CAP } from "./finance-report-export.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { baseCreditAmount, baseDebitAmount } from "../../accounting/core/journal-base-amount";
import {
  clients,
  expenses,
  expenseCategories,
  finBudgetLines,
  finBudgets,
  invoiceItems,
  invoices,
  journalEntries,
  journalLines,
  ledgerAccounts,
  orgUnits,
  payments,
  projects,
  purchaseBills,
  vendorCredits,
  vendorPayments,
} from "../../../db/schema";
import type { FinanceReportExportFilters } from "../../../db/schema/accounting/finance-report-export-jobs";

function csvRow(vals: unknown[]): string {
  return vals.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
}

@Injectable()
export class FinanceReportExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinanceReportExportWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: FinanceReportExportService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.FINANCE_REPORT_EXPORT_WORKER_ENABLED !== "false") {
      this.timer = setInterval(() => void this.tick(), 30000);
      this.timer.unref();
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  wake() {
    void this.tick();
  }

  private async tick() {
    if (this.running || !this.storage.isConfigured()) return;
    this.running = true;
    try {
      await forEachOrg(this.db, "finance-report-export-worker", async (_tx, orgId) => {
        const job = await this.jobs.claim(orgId);
        if (job) await this.process(job);
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async process(job: FinanceReportExportJobRow) {
    try {
      const f = job.filters;
      const { lines, truncated } = await this.buildLines(job.orgId, f);
      await this.jobs.progress(job.id, lines.length - 1);
      const result = await this.storage.uploadFile(
        job.orgId,
        Buffer.from(lines.join("\n"), "utf8"),
        "fin-report-exports",
        `fin-report-${job.id}.csv`,
        "text/csv",
      );
      const dataRows = lines.length - 1;
      await this.jobs.complete(job.id, result.key, `${f.reportType}-${f.from}-${f.to}.csv`, result.size, dataRows, truncated);
    } catch (error) {
      await this.jobs.fail(job, error);
    }
  }

  private async buildLines(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    switch (f.reportType) {
      case "vendor_statement": return this.buildVendorStatement(orgId, f);
      case "customer_statement": return this.buildCustomerStatement(orgId, f);
      case "sales_by_customer": return this.buildSalesByCustomer(orgId, f);
      case "sales_by_item": return this.buildSalesByItem(orgId, f);
      case "expense_by_category": return this.buildExpenseByCategory(orgId, f);
      case "tax_summary": return this.buildTaxSummary(orgId, f);
      case "project_profitability": return this.buildProjectProfitability(orgId, f);
      case "department_profitability": return this.buildDepartmentProfitability(orgId, f);
      case "budget_vs_actual": return this.buildBudgetVsActual(orgId, f);
    }
  }

  private async buildVendorStatement(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    if (!f.vendorId) throw new Error("vendorId required for vendor_statement");
    const lines = ["Date,Doc Type,Doc Number,Debit,Credit,Running Balance"];
    const lim = REPORT_LINE_CAP;

    const [billRows, paymentRows, creditRows] = await Promise.all([
      this.db
        .select({ id: purchaseBills.id, billNumber: purchaseBills.billNumber, billDate: purchaseBills.billDate, total: purchaseBills.total })
        .from(purchaseBills)
        .where(and(eq(purchaseBills.orgId, orgId), eq(purchaseBills.vendorId, f.vendorId), gte(purchaseBills.billDate, f.from), lte(purchaseBills.billDate, f.to), inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"])))
        .orderBy(asc(purchaseBills.billDate), asc(purchaseBills.id))
        .limit(lim + 1),
      this.db
        .select({ id: vendorPayments.id, referenceNumber: vendorPayments.referenceNumber, paymentDate: vendorPayments.paymentDate, amount: vendorPayments.amount })
        .from(vendorPayments)
        .innerJoin(purchaseBills, eq(purchaseBills.id, vendorPayments.billId))
        .where(and(eq(vendorPayments.orgId, orgId), eq(purchaseBills.vendorId, f.vendorId), gte(vendorPayments.paymentDate, f.from), lte(vendorPayments.paymentDate, f.to)))
        .orderBy(asc(vendorPayments.paymentDate), asc(vendorPayments.id))
        .limit(lim + 1),
      this.db
        .select({ id: vendorCredits.id, vendorCreditNumber: vendorCredits.vendorCreditNumber, createdAt: vendorCredits.createdAt, total: vendorCredits.total })
        .from(vendorCredits)
        .where(and(eq(vendorCredits.orgId, orgId), eq(vendorCredits.vendorId, f.vendorId), inArray(vendorCredits.status, ["POSTED", "APPLIED"]), gte(sql`${vendorCredits.createdAt}::date`, f.from), lte(sql`${vendorCredits.createdAt}::date`, f.to)))
        .orderBy(asc(vendorCredits.createdAt), asc(vendorCredits.id))
        .limit(lim + 1),
    ]);

    const hitCap = billRows.length > lim || paymentRows.length > lim || creditRows.length > lim;
    const safeBills = billRows.slice(0, lim);
    const safePayments = paymentRows.slice(0, lim);
    const safeCredits = creditRows.slice(0, lim);

    type RawLine = { date: string; docType: string; docNumber: string; debit: number; credit: number };
    const raw: RawLine[] = [];
    for (const b of safeBills) raw.push({ date: b.billDate, docType: "BILL", docNumber: b.billNumber, debit: Number(b.total ?? 0), credit: 0 });
    for (const p of safePayments) raw.push({ date: p.paymentDate, docType: "PAYMENT", docNumber: p.referenceNumber ?? `VP-${p.id}`, debit: 0, credit: Number(p.amount ?? 0) });
    for (const c of safeCredits) raw.push({ date: new Date(c.createdAt).toISOString().slice(0, 10), docType: "CREDIT_NOTE", docNumber: c.vendorCreditNumber, debit: 0, credit: Number(c.total ?? 0) });
    raw.sort((a, b) => a.date.localeCompare(b.date));

    const truncated = hitCap || raw.length > lim;
    const capped = truncated && raw.length > lim ? raw.slice(0, lim) : raw;
    let running = 0;
    for (const l of capped) {
      running = running + l.debit - l.credit;
      lines.push(csvRow([l.date, l.docType, l.docNumber, l.debit.toFixed(2), l.credit.toFixed(2), running.toFixed(2)]));
    }
    return { lines, truncated };
  }

  private async buildCustomerStatement(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    if (!f.clientId) throw new Error("clientId required for customer_statement");
    const lines = ["Date,Doc Type,Doc Number,Debit,Credit,Running Balance"];
    const lim = REPORT_LINE_CAP;

    const [invoiceRows, paymentRows] = await Promise.all([
      this.db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, createdAt: invoices.createdAt, total: invoices.total })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, f.clientId), inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]), gte(invoices.createdAt, new Date(`${f.from}T00:00:00.000Z`)), lte(invoices.createdAt, new Date(`${f.to}T23:59:59.000Z`))))
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(lim + 1),
      this.db
        .select({ id: payments.id, referenceNumber: payments.referenceNumber, paymentDate: payments.paymentDate, amount: payments.amount })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(payments.orgId, orgId), eq(invoices.clientId, f.clientId), gte(payments.paymentDate, f.from), lte(payments.paymentDate, f.to)))
        .orderBy(asc(payments.paymentDate), asc(payments.id))
        .limit(lim + 1),
    ]);

    const hitCap = invoiceRows.length > lim || paymentRows.length > lim;
    const safeInvoices = invoiceRows.slice(0, lim);
    const safePayments = paymentRows.slice(0, lim);

    type RawLine = { date: string; docType: string; docNumber: string; debit: number; credit: number };
    const raw: RawLine[] = [];
    for (const inv of safeInvoices) raw.push({ date: new Date(inv.createdAt).toISOString().slice(0, 10), docType: "INVOICE", docNumber: inv.invoiceNumber, debit: Number(inv.total ?? 0), credit: 0 });
    for (const p of safePayments) raw.push({ date: p.paymentDate, docType: "PAYMENT", docNumber: p.referenceNumber ?? `PMT-${p.id}`, debit: 0, credit: Number(p.amount ?? 0) });
    raw.sort((a, b) => a.date.localeCompare(b.date));

    const truncated = hitCap || raw.length > lim;
    const capped = truncated && raw.length > lim ? raw.slice(0, lim) : raw;
    let running = 0;
    for (const l of capped) {
      running = running + l.debit - l.credit;
      lines.push(csvRow([l.date, l.docType, l.docNumber, l.debit.toFixed(2), l.credit.toFixed(2), running.toFixed(2)]));
    }
    return { lines, truncated };
  }

  private async buildSalesByCustomer(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const rows = await this.db
      .select({ clientId: invoices.clientId, clientName: clients.name, invoiceCount: count(invoices.id), totalBilled: sum(invoices.total), totalPaid: sum(invoices.amountPaid) })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]), gte(invoices.createdAt, new Date(`${f.from}T00:00:00.000Z`)), lte(invoices.createdAt, new Date(`${f.to}T23:59:59.000Z`))))
      .groupBy(invoices.clientId, clients.name)
      .orderBy(sql`sum(${invoices.total}) desc`)
      .limit(REPORT_LINE_CAP + 1);
    const truncated = rows.length > REPORT_LINE_CAP;
    const capped = truncated ? rows.slice(0, REPORT_LINE_CAP) : rows;
    const lines = ["Client ID,Client Name,Invoice Count,Total Billed,Total Paid,Outstanding"];
    for (const r of capped) {
      const billed = Number(r.totalBilled ?? 0);
      const paid = Number(r.totalPaid ?? 0);
      lines.push(csvRow([r.clientId, r.clientName ?? "Unknown", Number(r.invoiceCount ?? 0), billed.toFixed(2), paid.toFixed(2), (billed - paid).toFixed(2)]));
    }
    return { lines, truncated };
  }

  private async buildSalesByItem(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const rows = await this.db
      .select({ description: invoiceItems.description, totalQuantity: sum(invoiceItems.quantity), totalAmount: sum(invoiceItems.amount), invoiceCount: count(invoices.id) })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]), gte(invoices.createdAt, new Date(`${f.from}T00:00:00.000Z`)), lte(invoices.createdAt, new Date(`${f.to}T23:59:59.000Z`))))
      .groupBy(invoiceItems.description)
      .orderBy(sql`sum(${invoiceItems.amount}) desc`)
      .limit(REPORT_LINE_CAP + 1);
    const truncated = rows.length > REPORT_LINE_CAP;
    const capped = truncated ? rows.slice(0, REPORT_LINE_CAP) : rows;
    const lines = ["Description,Total Quantity,Total Amount,Invoice Count"];
    for (const r of capped) {
      lines.push(csvRow([r.description, Number(r.totalQuantity ?? 0).toFixed(4), Number(r.totalAmount ?? 0).toFixed(2), Number(r.invoiceCount ?? 0)]));
    }
    return { lines, truncated };
  }

  private async buildExpenseByCategory(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const rows = await this.db
      .select({ categoryId: expenses.categoryId, categoryName: expenseCategories.name, totalAmount: sum(expenses.amount), cnt: count(expenses.id) })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(and(eq(expenses.orgId, orgId), inArray(expenses.status, ["APPROVED", "PAID"]), gte(expenses.expenseDate, f.from), lte(expenses.expenseDate, f.to)))
      .groupBy(expenses.categoryId, expenseCategories.name)
      .orderBy(sql`sum(${expenses.amount}) desc`)
      .limit(REPORT_LINE_CAP + 1);
    const truncated = rows.length > REPORT_LINE_CAP;
    const capped = truncated ? rows.slice(0, REPORT_LINE_CAP) : rows;
    const lines = ["Category ID,Category Name,Total Amount,Count"];
    for (const r of capped) {
      lines.push(csvRow([r.categoryId ?? "", r.categoryName ?? "Uncategorized", Number(r.totalAmount ?? 0).toFixed(2), Number(r.cnt ?? 0)]));
    }
    return { lines, truncated };
  }

  private async buildTaxSummary(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const [outputRows, inputRows] = await Promise.all([
      this.db
        .select({ month: sql<string>`to_char(date_trunc('month', ${invoices.createdAt}::date), 'YYYY-MM')`, cgst: sum(invoices.cgstAmount), sgst: sum(invoices.sgstAmount), igst: sum(invoices.igstAmount) })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]), gte(invoices.createdAt, new Date(`${f.from}T00:00:00.000Z`)), lte(invoices.createdAt, new Date(`${f.to}T23:59:59.000Z`))))
        .groupBy(sql`date_trunc('month', ${invoices.createdAt}::date)`)
        .orderBy(sql`date_trunc('month', ${invoices.createdAt}::date)`),
      this.db
        .select({ month: sql<string>`to_char(date_trunc('month', ${purchaseBills.billDate}::date), 'YYYY-MM')`, cgst: sum(purchaseBills.cgstAmount), sgst: sum(purchaseBills.sgstAmount), igst: sum(purchaseBills.igstAmount) })
        .from(purchaseBills)
        .where(and(eq(purchaseBills.orgId, orgId), inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"]), gte(purchaseBills.billDate, f.from), lte(purchaseBills.billDate, f.to)))
        .groupBy(sql`date_trunc('month', ${purchaseBills.billDate}::date)`)
        .orderBy(sql`date_trunc('month', ${purchaseBills.billDate}::date)`),
    ]);
    const allMonths = new Set<string>();
    for (const r of outputRows) if (r.month) allMonths.add(r.month);
    for (const r of inputRows) if (r.month) allMonths.add(r.month);
    const outputMap = new Map(outputRows.map((r) => [r.month ?? "", r]));
    const inputMap = new Map(inputRows.map((r) => [r.month ?? "", r]));
    const lines = ["Month,Output CGST,Output SGST,Output IGST,Input CGST,Input SGST,Input IGST,Net Payable"];
    for (const month of Array.from(allMonths).sort()) {
      const out = outputMap.get(month);
      const inp = inputMap.get(month);
      const oc = Number(out?.cgst ?? 0), os = Number(out?.sgst ?? 0), oi = Number(out?.igst ?? 0);
      const ic = Number(inp?.cgst ?? 0), is_ = Number(inp?.sgst ?? 0), ii = Number(inp?.igst ?? 0);
      lines.push(csvRow([month, oc.toFixed(2), os.toFixed(2), oi.toFixed(2), ic.toFixed(2), is_.toFixed(2), ii.toFixed(2), (oc + os + oi - ic - is_ - ii).toFixed(2)]));
    }
    return { lines, truncated: false };
  }

  private async buildProjectProfitability(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const [revenueRows, costJRows, costERows] = await Promise.all([
      this.db
        .select({ projectId: journalLines.projectId, totalCredit: sql<string>`coalesce(sum(${baseCreditAmount}), 0)`, totalDebit: sql<string>`coalesce(sum(${baseDebitAmount}), 0)` })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.status, "POSTED"), eq(ledgerAccounts.accountType, "INCOME"), isNotNull(journalLines.projectId), gte(journalEntries.entryDate, f.from), lte(journalEntries.entryDate, f.to)))
        .groupBy(journalLines.projectId),
      this.db
        .select({ projectId: journalLines.projectId, totalDebit: sql<string>`coalesce(sum(${baseDebitAmount}), 0)`, totalCredit: sql<string>`coalesce(sum(${baseCreditAmount}), 0)` })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.status, "POSTED"), eq(ledgerAccounts.accountType, "EXPENSE"), isNotNull(journalLines.projectId), gte(journalEntries.entryDate, f.from), lte(journalEntries.entryDate, f.to)))
        .groupBy(journalLines.projectId),
      this.db
        .select({ projectId: expenses.projectId, totalAmount: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
        .from(expenses)
        .where(and(eq(expenses.orgId, orgId), inArray(expenses.status, ["APPROVED", "PAID"]), isNotNull(expenses.projectId), gte(expenses.expenseDate, f.from), lte(expenses.expenseDate, f.to)))
        .groupBy(expenses.projectId),
    ]);
    const allIds = new Set<number>();
    for (const r of revenueRows) if (r.projectId !== null) allIds.add(r.projectId);
    for (const r of costJRows) if (r.projectId !== null) allIds.add(r.projectId);
    for (const r of costERows) if (r.projectId !== null) allIds.add(r.projectId);
    const projectRows = allIds.size > 0 ? await this.db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, Array.from(allIds))) : [];
    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));
    const revMap = new Map(revenueRows.map((r) => [r.projectId, r]));
    const cjMap = new Map(costJRows.map((r) => [r.projectId, r]));
    const ceMap = new Map(costERows.map((r) => [r.projectId, r]));
    const lines = ["Project ID,Project Name,Revenue,Cost,Margin,Margin %"];
    for (const pid of Array.from(allIds)) {
      const rev = revMap.get(pid), cj = cjMap.get(pid), ce = ceMap.get(pid);
      const revenue = Number(rev?.totalCredit ?? 0) - Number(rev?.totalDebit ?? 0);
      const cost = (Number(cj?.totalDebit ?? 0) - Number(cj?.totalCredit ?? 0)) + Number(ce?.totalAmount ?? 0);
      const margin = revenue - cost;
      lines.push(csvRow([pid, projectMap.get(pid) ?? `Project ${pid}`, revenue.toFixed(2), cost.toFixed(2), margin.toFixed(2), (revenue > 0 ? (margin / revenue) * 100 : 0).toFixed(2)]));
    }
    return { lines, truncated: false };
  }

  private async buildDepartmentProfitability(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    const [revenueRows, costRows] = await Promise.all([
      this.db
        .select({ departmentId: journalLines.departmentId, totalCredit: sql<string>`coalesce(sum(${baseCreditAmount}), 0)`, totalDebit: sql<string>`coalesce(sum(${baseDebitAmount}), 0)` })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.status, "POSTED"), eq(ledgerAccounts.accountType, "INCOME"), gte(journalEntries.entryDate, f.from), lte(journalEntries.entryDate, f.to)))
        .groupBy(journalLines.departmentId),
      this.db
        .select({ departmentId: journalLines.departmentId, totalDebit: sql<string>`coalesce(sum(${baseDebitAmount}), 0)`, totalCredit: sql<string>`coalesce(sum(${baseCreditAmount}), 0)` })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.status, "POSTED"), eq(ledgerAccounts.accountType, "EXPENSE"), gte(journalEntries.entryDate, f.from), lte(journalEntries.entryDate, f.to)))
        .groupBy(journalLines.departmentId),
    ]);
    const allIds = new Set<string>();
    for (const r of revenueRows) if (r.departmentId !== null) allIds.add(r.departmentId);
    for (const r of costRows) if (r.departmentId !== null) allIds.add(r.departmentId);
    const deptRows = allIds.size > 0 ? await this.db.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits).where(inArray(orgUnits.id, Array.from(allIds))) : [];
    const deptMap = new Map(deptRows.map((d) => [d.id, d.name]));
    const revMap = new Map(revenueRows.map((r) => [r.departmentId, r]));
    const costMap = new Map(costRows.map((r) => [r.departmentId, r]));
    const lines = ["Department ID,Department Name,Revenue,Cost,Margin,Margin %"];
    for (const did of Array.from(allIds)) {
      const rev = revMap.get(did), cst = costMap.get(did);
      const revenue = Number(rev?.totalCredit ?? 0) - Number(rev?.totalDebit ?? 0);
      const cost = Number(cst?.totalDebit ?? 0) - Number(cst?.totalCredit ?? 0);
      const margin = revenue - cost;
      lines.push(csvRow([did, deptMap.get(did) ?? `Department ${did}`, revenue.toFixed(2), cost.toFixed(2), margin.toFixed(2), (revenue > 0 ? (margin / revenue) * 100 : 0).toFixed(2)]));
    }
    return { lines, truncated: false };
  }

  private async buildBudgetVsActual(orgId: string, f: FinanceReportExportFilters): Promise<{ lines: string[]; truncated: boolean }> {
    if (!f.budgetId) throw new Error("budgetId required for budget_vs_actual");
    const budgetLineRows = await this.db
      .select({ accountId: finBudgetLines.accountId, accountName: ledgerAccounts.name, periodKey: finBudgetLines.periodKey, amount: finBudgetLines.amount })
      .from(finBudgetLines)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, finBudgetLines.accountId))
      .where(and(eq(finBudgetLines.budgetId, f.budgetId), eq(finBudgetLines.orgId, orgId)))
      .limit(REPORT_LINE_CAP + 1);
    const truncated = budgetLineRows.length > REPORT_LINE_CAP;
    const capped = truncated ? budgetLineRows.slice(0, REPORT_LINE_CAP) : budgetLineRows;
    const accountIds = [...new Set(capped.map((l) => l.accountId))];
    const actualRows = accountIds.length > 0
      ? await this.db
          .select({ accountId: journalLines.accountId, periodKey: sql<string>`to_char(date_trunc('month', ${journalEntries.entryDate}::date), 'YYYY-MM')`, totalDebit: sql<string>`coalesce(sum(${baseDebitAmount}), 0)`, totalCredit: sql<string>`coalesce(sum(${baseCreditAmount}), 0)`, accountType: ledgerAccounts.accountType })
          .from(journalLines)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.status, "POSTED"), inArray(journalLines.accountId, accountIds), gte(journalEntries.entryDate, f.from), lte(journalEntries.entryDate, f.to)))
          .groupBy(journalLines.accountId, ledgerAccounts.accountType, sql`date_trunc('month', ${journalEntries.entryDate}::date)`)
      : [];
    const actualMap = new Map<string, number>();
    for (const r of actualRows) {
      const key = `${r.accountId}::${r.periodKey}`;
      const normalDebit = r.accountType === "ASSET" || r.accountType === "EXPENSE";
      actualMap.set(key, normalDebit ? Number(r.totalDebit ?? 0) - Number(r.totalCredit ?? 0) : Number(r.totalCredit ?? 0) - Number(r.totalDebit ?? 0));
    }
    const lines = ["Account ID,Account Name,Period,Budget Amount,Actual Amount,Variance,Variance %"];
    for (const bl of capped) {
      const key = `${bl.accountId}::${bl.periodKey}`;
      const budgetAmount = Number(bl.amount ?? 0);
      const actualAmount = actualMap.get(key) ?? 0;
      const variance = actualAmount - budgetAmount;
      const variancePct = budgetAmount !== 0 ? (variance / Math.abs(budgetAmount)) * 100 : 0;
      lines.push(csvRow([bl.accountId, bl.accountName, bl.periodKey, budgetAmount.toFixed(2), actualAmount.toFixed(2), variance.toFixed(2), variancePct.toFixed(2)]));
    }
    return { lines, truncated };
  }
}
