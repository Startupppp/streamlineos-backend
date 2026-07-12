import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import { ledgerAccounts, journalEntries, journalLines } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import type { GlQuery, GlAccountsQuery } from "./dto/general-ledger.schemas";

function parseDecimal(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class GeneralLedgerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getGeneralLedger(orgId: string, query: GlQuery) {
    const { accountId, from, to, clientId, vendorId, projectId, departmentId, page, pageSize } = query;

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

    const openingDebit = parseDecimal(openingRows[0]?.totalDebit);
    const openingCredit = parseDecimal(openingRows[0]?.totalCredit);
    const openingBalance = openingDebit - openingCredit;

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

    const totalRows = await this.db
      .select({ c: count() })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...rangeConds));

    const total = Number(totalRows[0]?.c ?? 0);
    const { offset, limit } = paginateOffset({ page, pageSize });

    let priorPageBalance = openingBalance;
    if (offset > 0) {
      const priorPageRows = await this.db.execute(
        sql`
          SELECT
            coalesce(sum(d), 0) AS total_debit,
            coalesce(sum(c), 0) AS total_credit
          FROM (
            SELECT jl.debit AS d, jl.credit AS c
            FROM journal_lines jl
            INNER JOIN journal_entries je ON jl.entry_id = je.id
            WHERE
              jl.org_id = ${orgId}
              AND je.entry_date >= ${from}
              AND je.entry_date <= ${to}
              AND je.status = 'POSTED'
              ${accountId !== undefined ? sql`AND jl.account_id = ${accountId}` : sql``}
              ${clientId !== undefined ? sql`AND jl.client_id = ${clientId}` : sql``}
              ${vendorId !== undefined ? sql`AND jl.vendor_id = ${vendorId}` : sql``}
              ${projectId !== undefined ? sql`AND jl.project_id = ${projectId}` : sql``}
              ${departmentId !== undefined ? sql`AND jl.department_id = ${departmentId}` : sql``}
            ORDER BY je.entry_date, je.id, jl.line_order
            LIMIT ${offset}
          ) sub
        `,
      );
      const prRow = priorPageRows[0] as Record<string, unknown> | undefined;
      priorPageBalance =
        openingBalance +
        Number(prRow?.total_debit ?? 0) -
        Number(prRow?.total_credit ?? 0);
    }

    const rows = await this.db
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
      .where(and(...rangeConds))
      .orderBy(journalEntries.entryDate, journalEntries.id, journalLines.lineOrder)
      .offset(offset)
      .limit(limit);

    let runningBalance = priorPageBalance;
    const items = rows.map((row) => {
      const debit = parseDecimal(row.debit);
      const credit = parseDecimal(row.credit);
      runningBalance = runningBalance + debit - credit;
      return { ...row, debit, credit, runningBalance };
    });

    const allRangeRows = await this.db
      .select({
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...rangeConds));

    const closingBalance =
      openingBalance +
      parseDecimal(allRangeRows[0]?.totalDebit) -
      parseDecimal(allRangeRows[0]?.totalCredit);

    return {
      openingBalance,
      closingBalance,
      ...buildListResponse(items, total, { page, pageSize }),
    };
  }

  async getGeneralLedgerCsv(orgId: string, query: Omit<GlQuery, "page" | "pageSize" | "format">): Promise<string> {
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
        parseDecimal(r.debit).toFixed(2),
        parseDecimal(r.credit).toFixed(2),
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

    return rows.map((r) => ({
      ...r,
      periodDebit: parseDecimal(r.periodDebit),
      periodCredit: parseDecimal(r.periodCredit),
      netActivity: parseDecimal(r.periodDebit) - parseDecimal(r.periodCredit),
    }));
  }
}
