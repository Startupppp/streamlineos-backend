import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { clients, invoices, payments, ledgerAccounts, journalEntries, journalLines } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import { ACCOUNT_CODES } from "./posting-rules";
import type {
  AgedReceivablesRow,
  CustomerLedger,
  CustomerLedgerLine,
  CustomerOutstanding,
} from "./accounting.types";
import {
  type AgedReceivablesQuery,
  type ListCustomerLedgerQuery,
  type ListCustomersOutstandingQuery,
} from "./dto/accounting.schemas";

const RECEIVABLE_INVOICE_STATUSES = ["ISSUED", "FAILED", "PAID"] as const;

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function bucketFor(daysOverdue: number): "current" | "d1_30" | "d31_60" | "d61_90" | "d91_plus" {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d91_plus";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCustomers(orgId: string, query: ListCustomersOutstandingQuery) {
    const { page, pageSize, q, onlyOutstanding } = query;

    const paidExpr = sql<string>`COALESCE((
      SELECT SUM(${payments.amount})
      FROM ${payments}
      WHERE ${payments.orgId} = ${orgId}
        AND ${payments.invoiceId} IN (
          SELECT ${invoices.id}
          FROM ${invoices}
          WHERE ${invoices.orgId} = ${orgId}
            AND ${invoices.clientId} = ${clients.id}
        )
    ), 0)`;
    const invoiceCountExpr = sql<number>`COUNT(DISTINCT ${invoices.id})`;
    const outstandingExpr = sql<string>`(COALESCE(SUM(${invoices.total}), 0) - ${paidExpr})`;

    const conds = [eq(clients.orgId, orgId)];
    if (q) conds.push(ilike(clients.name, `%${escapeLike(q)}%`));

    const { offset, limit } = paginateOffset({ page, pageSize });
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
      .where(and(...conds))
      .groupBy(clients.id, clients.name, clients.state, clients.gstin)
      .$dynamic();
    if (onlyOutstanding) listQuery = listQuery.having(gt(outstandingExpr, "0"));

    const rows = await listQuery
      .orderBy(desc(outstandingExpr), asc(clients.name))
      .offset(offset)
      .limit(limit);

    const items: CustomerOutstanding[] = rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      state: r.state,
      gstin: r.gstin,
      invoiceCount: Number(r.invoiceCount ?? 0),
      outstanding: Number(r.outstanding ?? 0).toFixed(2),
    }));

    const totalRows = onlyOutstanding
      ? await this.db.select({ c: count() }).from(
          this.db
            .select({ id: clients.id })
            .from(clients)
            .leftJoin(invoices, and(eq(invoices.clientId, clients.id), eq(invoices.orgId, orgId)))
            .where(and(...conds))
            .groupBy(clients.id)
            .having(gt(outstandingExpr, "0"))
            .as("filtered_clients"),
        )
      : await this.db.select({ c: count() }).from(clients).where(and(...conds));

    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
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
    const totalInvoiced = Number(invoiceTotalsRows[0]?.total ?? 0);
    const totalPaid = Number(paymentTotalsRows[0]?.total ?? 0);

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
        totalInvoiced: totalInvoiced.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        outstanding: (totalInvoiced - totalPaid).toFixed(2),
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
    let running = 0;
    const lines: CustomerLedgerLine[] = [];
    for (const row of rows) {
      const debit = Number(row.debit ?? 0);
      const credit = Number(row.credit ?? 0);
      running += debit - credit;
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
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        runningBalance: running.toFixed(2),
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

  async agedReceivables(orgId: string, query: AgedReceivablesQuery) {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(`${asOf}T23:59:59.999Z`);

    const orgInvoices = await this.db
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientName: clients.name,
        total: invoices.total,
        dueDate: invoices.dueDate,
        createdAt: invoices.createdAt,
        paid: sql<string>`COALESCE((SELECT SUM(${payments.amount}::numeric)::text FROM ${payments} WHERE ${payments.invoiceId} = ${invoices.id} AND ${payments.paymentDate} <= ${asOf}), '0')`,
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, [...RECEIVABLE_INVOICE_STATUSES])));

    const byClient = new Map<number, AgedReceivablesRow>();
    for (const inv of orgInvoices) {
      if (inv.clientId === null) continue;
      const total = Number(inv.total ?? 0);
      const paid = Number(inv.paid ?? 0);
      const outstanding = total - paid;
      if (outstanding <= 0.005) continue;

      const referenceDate = inv.dueDate
        ? new Date(`${inv.dueDate}T23:59:59.999Z`)
        : inv.createdAt ?? asOfDate;
      const bucket = bucketFor(daysBetween(referenceDate, asOfDate));

      const existing = byClient.get(inv.clientId) ?? {
        clientId: inv.clientId,
        clientName: inv.clientName ?? `Client #${inv.clientId}`,
        current: "0",
        d1_30: "0",
        d31_60: "0",
        d61_90: "0",
        d91_plus: "0",
        total: "0",
      };

      const updated: AgedReceivablesRow = { ...existing };
      updated[bucket] = (Number(existing[bucket]) + outstanding).toFixed(2);
      updated.total = (Number(existing.total) + outstanding).toFixed(2);
      byClient.set(inv.clientId, updated);
    }

    const rows = Array.from(byClient.values()).sort((a, b) => Number(b.total) - Number(a.total));
    const totals = rows.reduce(
      (acc, row) => {
        acc.current += Number(row.current);
        acc.d1_30 += Number(row.d1_30);
        acc.d31_60 += Number(row.d31_60);
        acc.d61_90 += Number(row.d61_90);
        acc.d91_plus += Number(row.d91_plus);
        acc.total += Number(row.total);
        return acc;
      },
      { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0, total: 0 },
    );

    return {
      asOf,
      rows,
      totals: {
        current: totals.current.toFixed(2),
        d1_30: totals.d1_30.toFixed(2),
        d31_60: totals.d31_60.toFixed(2),
        d61_90: totals.d61_90.toFixed(2),
        d91_plus: totals.d91_plus.toFixed(2),
        total: totals.total.toFixed(2),
      },
    };
  }
}
