import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, lte, gte, or, sql, type SQL } from "drizzle-orm";
import { clients, invoices, payments, ledgerAccounts, journalEntries, journalLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import { ACCOUNT_CODES } from "./posting-rules";
import type {
  CustomerLedger,
  CustomerLedgerLine,
  CustomerOutstanding,
} from "./accounting.types";
import {
  type AgedReceivablesQuery,
  type ListCustomerLedgerQuery,
  type ListCustomersOutstandingQuery,
} from "./dto/accounting.schemas";
import { AccountingAgedReceivablesService } from "./accounting-aged-receivables.service";
import { addDecimals, roundDecimal, subtractDecimals, toDecimal } from "./money.util";

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

interface LedgerRow {
  date: string;
  entryId: number;
  entryNumber: string;
  sourceType: string;
  sourceId: string | null;
  sourceEvent: string | null;
  entryDescription: string | null;
  lineDescription: string | null;
  debit: string;
  credit: string;
}

@Injectable()
export class AccountingReceivablesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly agedService: AccountingAgedReceivablesService,
  ) {}

  async listCustomers(orgId: string, query: ListCustomersOutstandingQuery) {
    const { cursor, limit, q, onlyOutstanding } = query;
    const pos = decodeCursor(cursor);

    const paidSq = this.db
      .select({
        clientId: invoices.clientId,
        paid: sql<string>`COALESCE(SUM(${payments.amount}), 0)`.as("paid"),
      })
      .from(payments)
      .innerJoin(invoices, and(eq(payments.invoiceId, invoices.id), eq(invoices.orgId, orgId)))
      .where(eq(payments.orgId, orgId))
      .groupBy(invoices.clientId)
      .as("paid_sq");

    const paidAmt = sql<string>`COALESCE(${paidSq.paid}, 0)`;
    const invoiceCountExpr = sql<number>`COUNT(DISTINCT ${invoices.id})`;
    const outstandingExpr = sql<string>`(COALESCE(SUM(${invoices.total}), 0) - ${paidAmt})`;

    const conds = [eq(clients.orgId, orgId)];
    if (q) conds.push(ilike(clients.name, `%${escapeLike(q)}%`));
    if (pos) conds.push(keysetAfterValue(clients.name, clients.id, pos));

    let listQuery = this.db
      .select({
        clientId: clients.id,
        clientName: clients.name,
        state: clients.state,
        gstin: clients.gstin,
        invoiceCount: invoiceCountExpr,
        outstanding: outstandingExpr,
      })
      .from(clients)
      .leftJoin(invoices, and(eq(invoices.clientId, clients.id), eq(invoices.orgId, orgId)))
      .leftJoin(paidSq, eq(paidSq.clientId, clients.id))
      .where(and(...conds))
      .groupBy(clients.id, clients.name, clients.state, clients.gstin, paidSq.paid)
      .$dynamic();
    if (onlyOutstanding) listQuery = listQuery.having(gt(outstandingExpr, "0"));

    const rows = await listQuery.orderBy(asc(clients.name), asc(clients.id)).limit(limit + 1);

    const items: CustomerOutstanding[] = rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      state: r.state,
      gstin: r.gstin,
      invoiceCount: Number(r.invoiceCount ?? 0),
      outstanding: roundDecimal(toDecimal(r.outstanding), 2),
    }));

    return buildCursorPage(items, limit, (item) => ({ sortValue: item.clientName, id: String(item.clientId) }));
  }

  async customerLedger(orgId: string, clientId: number, query: ListCustomerLedgerQuery): Promise<CustomerLedger> {
    const [clientRows, arAccount, invoiceRows] = await Promise.all([
      this.db
        .select({ id: clients.id, name: clients.name, state: clients.state, gstin: clients.gstin })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)))
        .limit(1),
      this.db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.orgId, orgId), eq(ledgerAccounts.code, ACCOUNT_CODES.accountsReceivable)))
        .limit(1),
      this.db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId))),
    ]);

    const client = clientRows[0];
    if (!client) throw new NotFoundException("Client not found");
    const arAccountId = arAccount[0]?.id ?? null;
    const invoiceIds = invoiceRows.map((r) => r.id);

    const [paymentRows, invoiceTotalsRows, paymentTotalsRows] = await Promise.all([
      invoiceIds.length
        ? this.db
            .select({ id: payments.id, invoiceId: payments.invoiceId })
            .from(payments)
            .where(and(eq(payments.orgId, orgId), inArray(payments.invoiceId, invoiceIds)))
        : Promise.resolve<{ id: number; invoiceId: number }[]>([]),
      this.db
        .select({ total: sql<string>`COALESCE(SUM(${invoices.total}), 0)` })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId))),
      this.db
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)` })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(and(eq(payments.orgId, orgId), eq(invoices.clientId, clientId))),
    ]);

    const paymentIds = paymentRows.map((r) => r.id);
    const totalInvoiced = toDecimal(invoiceTotalsRows[0]?.total);
    const totalPaid = toDecimal(paymentTotalsRows[0]?.total);

    let lines: CustomerLedgerLine[] = [];
    if (arAccountId !== null) {
      const ledgerRows = await this.loadLedgerRows(orgId, arAccountId, invoiceIds, paymentIds, query);
      const invoiceById = new Map<number, string>(invoiceRows.map((r) => [r.id, r.invoiceNumber]));
      const paymentToInvoice = new Map<number, number>(paymentRows.map((r) => [r.id, r.invoiceId]));
      lines = this.buildLines(ledgerRows, invoiceById, paymentToInvoice);
    }

    return {
      summary: {
        clientId: client.id,
        clientName: client.name,
        state: client.state,
        gstin: client.gstin,
        totalInvoiced: roundDecimal(totalInvoiced, 2),
        totalPaid: roundDecimal(totalPaid, 2),
        outstanding: roundDecimal(subtractDecimals(totalInvoiced, totalPaid), 2),
      },
      lines,
    };
  }

  private async loadLedgerRows(
    orgId: string,
    arAccountId: number,
    invoiceIds: number[],
    paymentIds: number[],
    query: ListCustomerLedgerQuery,
  ): Promise<LedgerRow[]> {
    const sourceConds: Array<SQL | undefined> = [];
    if (invoiceIds.length > 0) {
      sourceConds.push(
        and(eq(journalEntries.sourceType, "invoice"), inArray(journalEntries.sourceId, invoiceIds.map(String))),
      );
    }
    if (paymentIds.length > 0) {
      sourceConds.push(
        and(eq(journalEntries.sourceType, "payment"), inArray(journalEntries.sourceId, paymentIds.map(String))),
      );
    }
    if (sourceConds.length === 0) return [];

    const conds = [
      eq(journalEntries.orgId, orgId),
      eq(journalEntries.status, "POSTED"),
      eq(journalLines.accountId, arAccountId),
    ];
    if (query.from) conds.push(gte(journalEntries.entryDate, query.from));
    if (query.to) conds.push(lte(journalEntries.entryDate, query.to));

    const orCond = sourceConds.length === 1 ? sourceConds[0] : or(...sourceConds);

    return this.db
      .select({
        date: journalEntries.entryDate,
        entryId: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        sourceEvent: journalEntries.sourceEvent,
        entryDescription: journalEntries.description,
        lineDescription: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(...conds, orCond))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id), asc(journalLines.lineOrder));
  }

  private buildLines(
    rows: ReadonlyArray<LedgerRow>,
    invoiceById: Map<number, string>,
    paymentToInvoice: Map<number, number>,
  ): CustomerLedgerLine[] {
    let running = "0";
    const lines: CustomerLedgerLine[] = [];
    for (const row of rows) {
      const debit = toDecimal(row.debit);
      const credit = toDecimal(row.credit);
      running = addDecimals(running, subtractDecimals(debit, credit));
      const { invoiceId, invoiceNumber } = this.resolveInvoiceFromSource(
        row.sourceType,
        row.sourceId,
        invoiceById,
        paymentToInvoice,
      );
      lines.push({
        date: row.date,
        entryId: row.entryId,
        entryNumber: row.entryNumber,
        sourceType: row.sourceType,
        sourceEvent: row.sourceEvent,
        description: row.lineDescription ?? row.entryDescription,
        invoiceId,
        invoiceNumber,
        debit: roundDecimal(debit, 2),
        credit: roundDecimal(credit, 2),
        runningBalance: roundDecimal(running, 2),
      });
    }
    return lines;
  }

  private resolveInvoiceFromSource(
    sourceType: string,
    sourceId: string | null,
    invoiceById: Map<number, string>,
    paymentToInvoice: Map<number, number>,
  ): { invoiceId: number | null; invoiceNumber: string | null } {
    if (!sourceId) return { invoiceId: null, invoiceNumber: null };
    const numeric = Number(sourceId);
    if (!Number.isInteger(numeric) || numeric <= 0) return { invoiceId: null, invoiceNumber: null };
    if (sourceType === "invoice") {
      return { invoiceId: numeric, invoiceNumber: invoiceById.get(numeric) ?? null };
    }
    if (sourceType === "payment") {
      const invoiceId = paymentToInvoice.get(numeric);
      if (invoiceId === undefined) return { invoiceId: null, invoiceNumber: null };
      return { invoiceId, invoiceNumber: invoiceById.get(invoiceId) ?? null };
    }
    return { invoiceId: null, invoiceNumber: null };
  }

  agedReceivables(orgId: string, query: AgedReceivablesQuery) {
    return this.agedService.agedReceivables(orgId, query);
  }
}
