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
import {
  compareDecimals,
  isZero,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
} from "./money.util";

const NORMAL_DEBIT: ReadonlyArray<string> = ["ASSET", "EXPENSE"];

interface AccountAggRow {
  accountId: number;
  code: string;
  name: string;
  accountType: AccountType;
  debit: string | null;
  credit: string | null;
}

interface TypedBalance {
  row: BalanceSheetRow;
  balance: string;
}

function rowsForType(rows: AccountAggRow[], type: AccountType, normalDebit: boolean): TypedBalance[] {
  return rows
    .filter((row) => row.accountType === type)
    .map((row) => {
      const debit = toDecimal(row.debit);
      const credit = toDecimal(row.credit);
      const balance = normalDebit
        ? subtractDecimals(debit, credit)
        : subtractDecimals(credit, debit);
      return {
        balance,
        row: {
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          accountType: type,
          balance: roundDecimal(balance, 2),
        },
      };
    })
    .filter((entry) => !isZero(entry.balance))
    .sort((a, b) => a.row.code.localeCompare(b.row.code));
}

function sumBalances(entries: TypedBalance[]): string {
  return sumDecimals(entries.map((entry) => entry.balance));
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

    const exact = rows.map((r) => {
      const debit = toDecimal(r.debit);
      const credit = toDecimal(r.credit);
      const normalDebit = NORMAL_DEBIT.includes(r.accountType);
      return {
        debit,
        credit,
        row: {
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          accountType: r.accountType,
          debit: roundDecimal(debit, 2),
          credit: roundDecimal(credit, 2),
          balance: roundDecimal(
            normalDebit ? subtractDecimals(debit, credit) : subtractDecimals(credit, debit),
            2,
          ),
        },
      };
    });

    const totalDebit = sumDecimals(exact.map((r) => r.debit));
    const totalCredit = sumDecimals(exact.map((r) => r.credit));

    return {
      asOf,
      rows: exact.map((r) => r.row).sort((a, b) => a.code.localeCompare(b.code)),
      totalDebit: roundDecimal(totalDebit, 2),
      totalCredit: roundDecimal(totalCredit, 2),
      balanced: compareDecimals(totalDebit, totalCredit) === 0,
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

    const incomeExact = rows
      .filter((r) => r.accountType === "INCOME")
      .map((r) => ({
        amount: subtractDecimals(toDecimal(r.credit), toDecimal(r.debit)),
        row: { accountId: r.accountId, code: r.code, name: r.name, accountType: "INCOME" as const },
      }))
      .sort((a, b) => a.row.code.localeCompare(b.row.code));
    const expenseExact = rows
      .filter((r) => r.accountType === "EXPENSE")
      .map((r) => ({
        amount: subtractDecimals(toDecimal(r.debit), toDecimal(r.credit)),
        row: { accountId: r.accountId, code: r.code, name: r.name, accountType: "EXPENSE" as const },
      }))
      .sort((a, b) => a.row.code.localeCompare(b.row.code));

    const totalIncome = sumDecimals(incomeExact.map((r) => r.amount));
    const totalExpense = sumDecimals(expenseExact.map((r) => r.amount));

    return {
      from: fromStr,
      to: toStr,
      income: incomeExact.map((r) => ({ ...r.row, amount: roundDecimal(r.amount, 2) })),
      expense: expenseExact.map((r) => ({ ...r.row, amount: roundDecimal(r.amount, 2) })),
      totalIncome: roundDecimal(totalIncome, 2),
      totalExpense: roundDecimal(totalExpense, 2),
      netIncome: roundDecimal(subtractDecimals(totalIncome, totalExpense), 2),
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
    const retainedEarnings = subtractDecimals(sumBalances(incomeRows), sumBalances(expenseRows));

    const totalAssets = sumBalances(assets);
    const totalLiabilities = sumBalances(liabilities);
    const totalEquity = sumDecimals([sumBalances(equity), retainedEarnings]);

    return {
      asOf,
      assets: assets.map((entry) => entry.row),
      liabilities: liabilities.map((entry) => entry.row),
      equity: equity.map((entry) => entry.row),
      retainedEarnings: roundDecimal(retainedEarnings, 2),
      totalAssets: roundDecimal(totalAssets, 2),
      totalLiabilities: roundDecimal(totalLiabilities, 2),
      totalEquity: roundDecimal(totalEquity, 2),
      balanced:
        compareDecimals(totalAssets, sumDecimals([totalLiabilities, totalEquity])) === 0,
    };
  }

  cashFlow(orgId: string, query: ProfitLossQuery) {
    return this.cashFlowService.cashFlow(orgId, query);
  }
}
