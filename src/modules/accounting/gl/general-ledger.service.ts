import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import type { GlQuery, GlAccountsQuery } from "./dto/general-ledger.schemas";
import {
  addDecimals,
  roundDecimal,
  subtractDecimals,
  toDecimal,
} from "../core/money.util";

/**
 * The general-ledger response has always carried money as JSON numbers. Every sum
 * above is exact bigint arithmetic; this is the single conversion at the edge, so
 * no error can accumulate across rows.
 */
function emitAmount(decimal: string): number {
  return Number(decimal);
}

@Injectable()
export class GeneralLedgerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getGeneralLedger(orgId: string, query: GlQuery) {
    const { accountId, from, to, clientId, vendorId, projectId, departmentId, cursor, limit } = query;
    const pos = decodeCursor(cursor);

    const openingConds = [
      eq(journalLines.orgId, orgId),
      sql`${journalEntries.entryDate} < ${from}`,
      eq(journalEntries.status, "POSTED"),
    ];
    if (accountId !== undefined) openingConds.push(eq(journalLines.accountId, accountId));
    if (clientId !== undefined) openingConds.push(eq(journalLines.clientId, clientId));
    if (vendorId !== undefined) openingConds.push(eq(journalLines.vendorId, vendorId));
    if (projectId !== undefined) openingConds.push(eq(journalLines.projectId, projectId));
    if (departmentId !== undefined) openingConds.push(eq(journalLines.departmentId, departmentId));

    const openingRows = await this.db
      .select({
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...openingConds));

    const openingDebit = toDecimal(openingRows[0]?.totalDebit);
    const openingCredit = toDecimal(openingRows[0]?.totalCredit);
    const openingBalance = subtractDecimals(openingDebit, openingCredit);

    const rangeConds = [
      eq(journalLines.orgId, orgId),
      gte(journalEntries.entryDate, from),
      lte(journalEntries.entryDate, to),
      eq(journalEntries.status, "POSTED"),
    ];
    if (accountId !== undefined) rangeConds.push(eq(journalLines.accountId, accountId));
    if (clientId !== undefined) rangeConds.push(eq(journalLines.clientId, clientId));
    if (vendorId !== undefined) rangeConds.push(eq(journalLines.vendorId, vendorId));
    if (projectId !== undefined) rangeConds.push(eq(journalLines.projectId, projectId));
    if (departmentId !== undefined) rangeConds.push(eq(journalLines.departmentId, departmentId));

    let priorPageBalance = openingBalance;
    if (pos) {
      const balanceConds = [
        ...rangeConds,
        or(
          lt(journalEntries.entryDate, pos.sortValue),
          and(eq(journalEntries.entryDate, pos.sortValue), lte(journalLines.id, Number(pos.id))),
        ),
      ];
      const balanceRows = await this.db
        .select({
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(...balanceConds));
      const bRow = balanceRows[0];
      priorPageBalance = addDecimals(
        openingBalance,
        subtractDecimals(toDecimal(bRow?.totalDebit), toDecimal(bRow?.totalCredit)),
      );
    }

    const pageConds = pos ? [...rangeConds, keysetAfterValue(journalEntries.entryDate, journalLines.id, pos)] : rangeConds;

    const [rows, allRangeRows] = await Promise.all([
      this.db
        .select({
          lineId: journalLines.id,
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          entryDate: journalEntries.entryDate,
          description: journalLines.description,
          entryDescription: journalEntries.description,
          accountId: journalLines.accountId,
          accountCode: ledgerAccounts.code,
          accountName: ledgerAccounts.name,
          debit: journalLines.debit,
          credit: journalLines.credit,
          sourceType: journalEntries.sourceType,
          sourceId: journalEntries.sourceId,
          clientId: journalLines.clientId,
          vendorId: journalLines.vendorId,
          projectId: journalLines.projectId,
          departmentId: journalLines.departmentId,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
        .where(and(...pageConds))
        .orderBy(journalEntries.entryDate, journalLines.id)
        .limit(limit + 1),
      this.db
        .select({
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(...rangeConds)),
    ]);

    const closingBalance = addDecimals(
      openingBalance,
      subtractDecimals(
        toDecimal(allRangeRows[0]?.totalDebit),
        toDecimal(allRangeRows[0]?.totalCredit),
      ),
    );

    const cursorPage = buildCursorPage(rows, limit, (row) => ({ sortValue: String(row.entryDate ?? ""), id: String(row.lineId) }));
    let runningBalance = priorPageBalance;
    const items = cursorPage.data.map((row) => {
      const debit = toDecimal(row.debit);
      const credit = toDecimal(row.credit);
      runningBalance = addDecimals(runningBalance, subtractDecimals(debit, credit));
      return {
        ...row,
        debit: emitAmount(debit),
        credit: emitAmount(credit),
        runningBalance: emitAmount(runningBalance),
      };
    });

    return {
      openingBalance: emitAmount(openingBalance),
      closingBalance: emitAmount(closingBalance),
      items,
      nextCursor: cursorPage.pagination.nextCursor,
    };
  }

  async getGeneralLedgerCsv(orgId: string, query: Omit<GlQuery, "cursor" | "limit" | "format">): Promise<string> {
    const { accountId, from, to, clientId, vendorId, projectId, departmentId } = query;

    const rangeConds = [
      eq(journalLines.orgId, orgId),
      gte(journalEntries.entryDate, from),
      lte(journalEntries.entryDate, to),
      eq(journalEntries.status, "POSTED"),
    ];
    if (accountId !== undefined) rangeConds.push(eq(journalLines.accountId, accountId));
    if (clientId !== undefined) rangeConds.push(eq(journalLines.clientId, clientId));
    if (vendorId !== undefined) rangeConds.push(eq(journalLines.vendorId, vendorId));
    if (projectId !== undefined) rangeConds.push(eq(journalLines.projectId, projectId));
    if (departmentId !== undefined) rangeConds.push(eq(journalLines.departmentId, departmentId));

    const rows = await this.db
      .select({
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        description: journalLines.description,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(and(...rangeConds))
      .orderBy(journalEntries.entryDate, journalEntries.id, journalLines.lineOrder)
      .limit(10000);

    const header = "Entry Number,Date,Description,Account Code,Account Name,Debit,Credit";
    const lines = rows.map((r) =>
      [
        r.entryNumber,
        r.entryDate,
        `"${(r.description ?? "").replace(/"/g, '""')}"`,
        r.accountCode,
        `"${r.accountName.replace(/"/g, '""')}"`,
        roundDecimal(toDecimal(r.debit), 2),
        roundDecimal(toDecimal(r.credit), 2),
      ].join(","),
    );
    return [header, ...lines].join("\n");
  }

  async getAccountsWithActivity(orgId: string, query: GlAccountsQuery) {
    const { from, to, type } = query;

    const conds = [
      eq(journalLines.orgId, orgId),
      gte(journalEntries.entryDate, from),
      lte(journalEntries.entryDate, to),
      eq(journalEntries.status, "POSTED"),
    ];
    if (type !== undefined) conds.push(eq(ledgerAccounts.accountType, type));

    const rows = await this.db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
        periodDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        periodCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
      .where(and(...conds))
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.accountType)
      .orderBy(ledgerAccounts.code);

    return rows.map((r) => {
      const periodDebit = toDecimal(r.periodDebit);
      const periodCredit = toDecimal(r.periodCredit);
      return {
        ...r,
        periodDebit: emitAmount(periodDebit),
        periodCredit: emitAmount(periodCredit),
        netActivity: emitAmount(subtractDecimals(periodDebit, periodCredit)),
      };
    });
  }
}
