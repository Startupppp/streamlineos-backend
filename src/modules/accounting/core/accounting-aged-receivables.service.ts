import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { clients, invoices, payments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { AgedReceivablesRow } from "./accounting.types";
import { type AgedReceivablesQuery } from "./dto/accounting.schemas";
import { addDecimals, compareDecimals, roundDecimal, subtractDecimals, sumDecimals, toDecimal } from "./money.util";

const RECEIVABLE_INVOICE_STATUSES = ["ISSUED", "FAILED", "PAID"] as const;

type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d91_plus";

const BUCKETS: ReadonlyArray<Bucket> = ["current", "d1_30", "d31_60", "d61_90", "d91_plus"];

interface ExactAging {
  clientId: number;
  clientName: string;
  amounts: Record<Bucket, string>;
  total: string;
}

function emptyAmounts(): Record<Bucket, string> {
  return { current: "0", d1_30: "0", d31_60: "0", d61_90: "0", d91_plus: "0" };
}

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d91_plus";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

@Injectable()
export class AccountingAgedReceivablesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

    const byClient = new Map<number, ExactAging>();
    for (const inv of orgInvoices) {
      if (inv.clientId === null) continue;
      const outstanding = subtractDecimals(toDecimal(inv.total), toDecimal(inv.paid));
      if (compareDecimals(outstanding, "0") <= 0) continue;

      const referenceDate = inv.dueDate
        ? new Date(`${inv.dueDate}T23:59:59.999Z`)
        : inv.createdAt ?? asOfDate;
      const bucket = bucketFor(daysBetween(referenceDate, asOfDate));

      const existing = byClient.get(inv.clientId) ?? {
        clientId: inv.clientId,
        clientName: inv.clientName ?? `Client #${inv.clientId}`,
        amounts: emptyAmounts(),
        total: "0",
      };
      existing.amounts[bucket] = addDecimals(existing.amounts[bucket], outstanding);
      existing.total = addDecimals(existing.total, outstanding);
      byClient.set(inv.clientId, existing);
    }

    const exact = Array.from(byClient.values()).sort((a, b) => compareDecimals(b.total, a.total));
    const rows: AgedReceivablesRow[] = exact.map((entry) => ({
      clientId: entry.clientId,
      clientName: entry.clientName,
      current: roundDecimal(entry.amounts.current, 2),
      d1_30: roundDecimal(entry.amounts.d1_30, 2),
      d31_60: roundDecimal(entry.amounts.d31_60, 2),
      d61_90: roundDecimal(entry.amounts.d61_90, 2),
      d91_plus: roundDecimal(entry.amounts.d91_plus, 2),
      total: roundDecimal(entry.total, 2),
    }));

    const totalFor = (bucket: Bucket): string =>
      roundDecimal(sumDecimals(exact.map((entry) => entry.amounts[bucket])), 2);

    return {
      asOf,
      rows,
      totals: {
        current: totalFor(BUCKETS[0]),
        d1_30: totalFor(BUCKETS[1]),
        d31_60: totalFor(BUCKETS[2]),
        d61_90: totalFor(BUCKETS[3]),
        d91_plus: totalFor(BUCKETS[4]),
        total: roundDecimal(sumDecimals(exact.map((entry) => entry.total)), 2),
      },
    };
  }
}
