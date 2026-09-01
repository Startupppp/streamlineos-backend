import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import type { AccountType, BalanceSheetRow } from "./accounting.types";
import {
  type BalanceSheetQuery,
  type ProfitLossQuery,
  type TrialBalanceQuery,
} from "./dto/accounting.schemas";
import { AccountingCashFlowService } from "./accounting-cash-flow.service";

const NORMAL_DEBIT: ReadonlyArray<string> = ["ASSET", "EXPENSE"];

interface AccountAggRow {
  accountId: number;
  code: string;
  name: string;
  accountType: AccountType;
  debit: string | null;
  credit: string | null;
}

function rowsForType(rows: AccountAggRow[], type: AccountType, normalDebit: boolean): BalanceSheetRow[] {
  return rows
    .filter((row) => row.accountType === type)
    .map((row) => {
      const debit = Number(row.debit ?? 0);
      const credit = Number(row.credit ?? 0);
      const balance = normalDebit ? debit - credit : credit - debit;
      return { accountId: row.accountId, code: row.code, name: row.name, accountType: type, balance: balance.toFixed(2) };
    })
    .filter((row) => Math.abs(Number(row.balance)) >= 0.005)
    .sort((a, b) => a.code.localeCompare(b.code));
}

function sumRows(rows: BalanceSheetRow[]): number {
  return rows.reduce((acc, row) => acc + Number(row.balance), 0);
}

@Injectable()
export class AccountingStatementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly cashFlowService: AccountingCashFlowService,
  ) {}

  async trialBalance(orgId: string, query: TrialBalanceQuery) {
    const { asOf } = query;
    return this.cache.cachedVersioned(ACCT_STATEMENTS_NS(orgId), `trial-balance:${asOf}`, () => this.computeTrialBalance(orgId, asOf), CACHE_TTL.MEDIUM);
  }

  private async computeTrialBalance(orgId: string, asOf: string) {
    const rows = await this.db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
        debit: sum(journalLines.debit),
        credit: sum(journalLines.credit),
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(ledgerAccounts.orgId, orgId),
          lte(journalEntries.entryDate, asOf),
          eq(journalEntries.status, "POSTED"),
        ),
      )
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.accountType);

    const tb = rows.map((r) => {
      const debit = Number(r.debit ?? 0);
      const credit = Number(r.credit ?? 0);
      const normalDebit = NORMAL_DEBIT.includes(r.accountType);
      const balance = normalDebit ? debit - credit : credit - debit;
      return {
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        accountType: r.accountType,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        balance: balance.toFixed(2),
      };
    });

    const totalDebit = tb.reduce((acc, r) => acc + Number(r.debit), 0);
    const totalCredit = tb.reduce((acc, r) => acc + Number(r.credit), 0);

    return {
      asOf,
      rows: tb.sort((a, b) => a.code.localeCompare(b.code)),
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
    };
  }

  async profitLoss(orgId: string, query: ProfitLossQuery) {
    const { from, to } = query;
    if (!from || !to) throw new BadRequestException("from and to are required");
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    return this.cache.cachedVersioned(ACCT_STATEMENTS_NS(orgId), `profit-loss:${fromStr}:${toStr}`, () => this.computeProfitLoss(orgId, from, to), CACHE_TTL.MEDIUM);
  }

  private async computeProfitLoss(orgId: string, from: Date, to: Date) {
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
        debit: sum(journalLines.debit),
        credit: sum(journalLines.credit),
      })
      .from(ledgerAccounts)
      .innerJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(ledgerAccounts.orgId, orgId),
          inArray(ledgerAccounts.accountType, ["INCOME", "EXPENSE"]),
          gte(journalEntries.entryDate, fromStr),
          lte(journalEntries.entryDate, toStr),
          eq(journalEntries.status, "POSTED"),
        ),
      )
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.accountType);

    const income = rows
      .filter((r) => r.accountType === "INCOME")
      .map((r) => ({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        accountType: "INCOME" as const,
        amount: (Number(r.credit ?? 0) - Number(r.debit ?? 0)).toFixed(2),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const expense = rows
      .filter((r) => r.accountType === "EXPENSE")
      .map((r) => ({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        accountType: "EXPENSE" as const,
        amount: (Number(r.debit ?? 0) - Number(r.credit ?? 0)).toFixed(2),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const totalIncome = income.reduce((acc, r) => acc + Number(r.amount), 0);
    const totalExpense = expense.reduce((acc, r) => acc + Number(r.amount), 0);

    return {
      from: fromStr,
      to: toStr,
      income,
      expense,
      totalIncome: totalIncome.toFixed(2),
      totalExpense: totalExpense.toFixed(2),
      netIncome: (totalIncome - totalExpense).toFixed(2),
    };
  }

  async balanceSheet(orgId: string, query: BalanceSheetQuery) {
    const { asOf } = query;
    return this.cache.cachedVersioned(ACCT_STATEMENTS_NS(orgId), `balance-sheet:${asOf}`, () => this.computeBalanceSheet(orgId, asOf), CACHE_TTL.MEDIUM);
  }

  private async computeBalanceSheet(orgId: string, asOf: string) {
    const rows: AccountAggRow[] = await this.db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
        debit: sum(journalLines.debit),
        credit: sum(journalLines.credit),
      })
      .from(ledgerAccounts)
      .leftJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(ledgerAccounts.orgId, orgId),
          lte(journalEntries.entryDate, asOf),
          eq(journalEntries.status, "POSTED"),
        ),
      )
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.accountType)
      .orderBy(asc(ledgerAccounts.code));

    const assets = rowsForType(rows, "ASSET", true);
    const liabilities = rowsForType(rows, "LIABILITY", false);
    const equity = rowsForType(rows, "EQUITY", false);

    const incomeRows = rowsForType(rows, "INCOME", false);
    const expenseRows = rowsForType(rows, "EXPENSE", true);
    const retainedEarnings = sumRows(incomeRows) - sumRows(expenseRows);

    const totalAssets = sumRows(assets);
    const totalLiabilities = sumRows(liabilities);
    const totalEquity = sumRows(equity) + retainedEarnings;

    return {
      asOf,
      assets,
      liabilities,
      equity,
      retainedEarnings: retainedEarnings.toFixed(2),
      totalAssets: totalAssets.toFixed(2),
      totalLiabilities: totalLiabilities.toFixed(2),
      totalEquity: totalEquity.toFixed(2),
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    };
  }

  cashFlow(orgId: string, query: ProfitLossQuery) {
    return this.cashFlowService.cashFlow(orgId, query);
  }
}
