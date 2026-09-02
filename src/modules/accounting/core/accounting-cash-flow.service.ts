import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sum } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";
import { ACCOUNT_CODES } from "./posting-rules";
import { type ProfitLossQuery } from "./dto/accounting.schemas";
import type { AccountType } from "./accounting.types";
import {
  absDecimal,
  addDecimals,
  allocateDecimal,
  compareDecimals,
  isZero,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
} from "./money.util";

type SectionKey = "operating" | "investing" | "financing";

const CASH_CODES: ReadonlyArray<string> = [ACCOUNT_CODES.cash, ACCOUNT_CODES.bank];
const SECTION_KEYS: ReadonlyArray<SectionKey> = ["operating", "investing", "financing"];
const SECTION_LABELS: Record<SectionKey, string> = {
  operating: "Operating Activities",
  investing: "Investing Activities",
  financing: "Financing Activities",
};

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

@Injectable()
export class AccountingCashFlowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async cashFlow(orgId: string, query: ProfitLossQuery) {
    const { from, to } = query;
    if (!from || !to) throw new BadRequestException("from and to are required");
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    return this.cache.cachedVersioned(
      ACCT_STATEMENTS_NS(orgId),
      `cash-flow:${fromStr}:${toStr}`,
      () => this.computeCashFlow(orgId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeCashFlow(orgId: string, from: Date, to: Date) {
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
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

    const cashNetUpTo = async (asOf: string): Promise<string> => {
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
      return subtractDecimals(toDecimal(row?.debit), toDecimal(row?.credit));
    };

    const openingCash = await cashNetUpTo(openingAsOf);
    const closingCash = await cashNetUpTo(toStr);
    const netChange = subtractDecimals(closingCash, openingCash);

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

    const buckets: Record<SectionKey, Map<string, string>> = {
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
        const cashMovement = sumDecimals(
          entryLines
            .filter((line) => cashIdSet.has(line.accountId))
            .map((line) => subtractDecimals(toDecimal(line.debit), toDecimal(line.credit))),
        );
        if (isZero(cashMovement)) continue;

        const offsetting = entryLines.filter((line) => !cashIdSet.has(line.accountId));
        const weights = offsetting.map((line) =>
          absDecimal(subtractDecimals(toDecimal(line.debit), toDecimal(line.credit))),
        );
        if (isZero(sumDecimals(weights))) continue;

        const inflows = allocateDecimal(cashMovement, weights);
        offsetting.forEach((line, index) => {
          const inflow = inflows[index];
          if (isZero(inflow)) return;
          const section = classify(line.accountType, line.code);
          const key = `${line.code}::${line.name}`;
          const bucket = buckets[section];
          bucket.set(key, addDecimals(bucket.get(key) ?? "0", inflow));
        });
      }
    }

    const sectionTotals: string[] = [];
    const sections = SECTION_KEYS.map((key) => {
      const items = Array.from(buckets[key].entries())
        .map(([compound, amount]) => {
          const [code, name] = compound.split("::");
          return { label: `${code} - ${name}`, amount };
        })
        .filter((item) => !isZero(item.amount))
        .sort((a, b) => a.label.localeCompare(b.label));
      const total = sumDecimals(items.map((item) => item.amount));
      sectionTotals.push(total);
      return {
        key,
        label: SECTION_LABELS[key],
        items: items.map((item) => ({ label: item.label, amount: roundDecimal(item.amount, 2) })),
        total: roundDecimal(total, 2),
      };
    });

    const sectionsTotal = sumDecimals(sectionTotals);

    return {
      from: fromStr,
      to: toStr,
      openingCash: roundDecimal(openingCash, 2),
      closingCash: roundDecimal(closingCash, 2),
      netChange: roundDecimal(netChange, 2),
      reconciled: compareDecimals(sectionsTotal, netChange) === 0,
      sections,
    };
  }
}
