import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { clients, invoices, payments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { AgedReceivablesRow } from "./accounting.types";
import { type AgedReceivablesQuery } from "./dto/accounting.schemas";

const RECEIVABLE_INVOICE_STATUSES = ["ISSUED", "FAILED", "PAID"] as const;

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
