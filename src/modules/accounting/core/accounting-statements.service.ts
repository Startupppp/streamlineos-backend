import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import { ACCOUNT_CODES } from "./posting-rules";
import type { AccountType, BalanceSheetRow } from "./accounting.types";
import {
  type BalanceSheetQuery,
  type ProfitLossQuery,
  type TrialBalanceQuery,
} from "./dto/accounting.schemas";

type SectionKey = "operating" | "investing" | "financing";

const NORMAL_DEBIT: ReadonlyArray<string> = ["ASSET", "EXPENSE"];
const CASH_CODES: ReadonlyArray<string> = [ACCOUNT_CODES.cash, ACCOUNT_CODES.bank];
const SECTION_KEYS: ReadonlyArray<SectionKey> = ["operating", "investing", "financing"];
const SECTION_LABELS: Record<SectionKey, string> = {
  operating: "Operating Activities",
  investing: "Investing Activities",
  financing: "Financing Activities",
};

interface AccountAggRow {
  accountId: number;
  code: string;
  name: string;
  accountType: AccountType;
  debit: string | null;
  credit: string | null;
}

function previousDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function classify(accountType: AccountType, code: string): SectionKey {
  if (accountType === "EQUITY") return "financing";
  if (accountType === "LIABILITY") return code === "2700" ? "financing" : "operating";
  if (accountType === "ASSET") {
    if (code.startsWith("15") || code === "1600") return "investing";
    return "operating";
  }
  return "operating";
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
    return this.cache.cachedVersioned(ACCT_STATEMENTS_NS(orgId), `profit-loss:${from}:${to}`, () => this.computeProfitLoss(orgId, from, to), CACHE_TTL.MEDIUM);
  }

  private async computeProfitLoss(orgId: string, from: string, to: string) {
    const fromStr = from;
    const toStr = to;

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

  async cashFlow(orgId: string, query: ProfitLossQuery) {
    const { from, to } = query;
    if (!from || !to) throw new BadRequestException("from and to are required");
    return this.cache.cachedVersioned(ACCT_STATEMENTS_NS(orgId), `cash-flow:${from}:${to}`, () => this.computeCashFlow(orgId, from, to), CACHE_TTL.MEDIUM);
  }

  private async computeCashFlow(orgId: string, from: string, to: string) {
    const fromStr = from;
    const toStr = to;
    const openingAsOf = previousDay(fromStr);

    const cashAccounts = await this.db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.orgId, orgId), inArray(ledgerAccounts.code, [...CASH_CODES])));
    const cashAccountIds = cashAccounts.map((row) => row.id);

    if (cashAccountIds.length === 0) {
      return {
        from: fromStr,
        to: toStr,
        openingCash: "0.00",
        closingCash: "0.00",
        netChange: "0.00",
        reconciled: true,
        sections: SECTION_KEYS.map((key) => ({
          key,
          label: SECTION_LABELS[key],
          items: [],
          total: "0.00",
        })),
      };
    }

    const cashNetUpTo = async (asOf: string): Promise<number> => {
      const rows = await this.db
        .select({ debit: sum(journalLines.debit), credit: sum(journalLines.credit) })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            lte(journalEntries.entryDate, asOf),
            inArray(journalLines.accountId, cashAccountIds),
          ),
        );
      const row = rows[0];
      return Number(row?.debit ?? 0) - Number(row?.credit ?? 0);
    };

    const openingCash = await cashNetUpTo(openingAsOf);
    const closingCash = await cashNetUpTo(toStr);
    const netChange = closingCash - openingCash;

    const periodCashEntries = await this.db
      .selectDistinct({ entryId: journalLines.entryId })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.status, "POSTED"),
          gte(journalEntries.entryDate, fromStr),
          lte(journalEntries.entryDate, toStr),
          inArray(journalLines.accountId, cashAccountIds),
        ),
      );
    const entryIds = periodCashEntries.map((row) => row.entryId);

    const buckets: Record<SectionKey, Map<string, number>> = {
      operating: new Map(),
      investing: new Map(),
      financing: new Map(),
    };

    if (entryIds.length > 0) {
      const lines = await this.db
        .select({
          entryId: journalLines.entryId,
          accountId: journalLines.accountId,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          accountType: ledgerAccounts.accountType,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .where(inArray(journalLines.entryId, entryIds));

      const cashIdSet = new Set(cashAccountIds);
      const grouped = new Map<number, typeof lines>();
      for (const line of lines) {
        const existing = grouped.get(line.entryId);
        if (existing) existing.push(line);
        else grouped.set(line.entryId, [line]);
      }

      for (const entryLines of grouped.values()) {
        const cashMovement = entryLines
          .filter((line) => cashIdSet.has(line.accountId))
          .reduce((acc, line) => acc + (Number(line.debit) - Number(line.credit)), 0);
        if (Math.abs(cashMovement) < 0.005) continue;

        const offsetting = entryLines.filter((line) => !cashIdSet.has(line.accountId));
        const offsetTotal = offsetting.reduce(
          (acc, line) => acc + Math.abs(Number(line.debit) - Number(line.credit)),
          0,
        );
        if (offsetTotal < 0.005) continue;

        for (const line of offsetting) {
          const weight = Math.abs(Number(line.debit) - Number(line.credit)) / offsetTotal;
          const inflow = cashMovement * weight;
          if (Math.abs(inflow) < 0.005) continue;
          const section = classify(line.accountType, line.code);
          const key = `${line.code}::${line.name}`;
          const bucket = buckets[section];
          bucket.set(key, (bucket.get(key) ?? 0) + inflow);
        }
      }
    }

    const sections = SECTION_KEYS.map((key) => {
      const items = Array.from(buckets[key].entries())
        .map(([compound, amount]) => {
          const [code, name] = compound.split("::");
          return { label: `${code} - ${name}`, amount };
        })
        .filter((item) => Math.abs(item.amount) >= 0.005)
        .sort((a, b) => a.label.localeCompare(b.label));
      const total = items.reduce((acc, item) => acc + item.amount, 0);
      return {
        key,
        label: SECTION_LABELS[key],
        items: items.map((item) => ({ label: item.label, amount: item.amount.toFixed(2) })),
        total: total.toFixed(2),
      };
    });

    const sectionsTotal = sections.reduce((acc, section) => acc + Number(section.total), 0);

    return {
      from: fromStr,
      to: toStr,
      openingCash: openingCash.toFixed(2),
      closingCash: closingCash.toFixed(2),
      netChange: netChange.toFixed(2),
      reconciled: Math.abs(sectionsTotal - netChange) < 0.01,
      sections,
    };
  }
}
