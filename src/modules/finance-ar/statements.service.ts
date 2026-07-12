import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invoices, payments, creditNotes, clients } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CustomerStatementQuery } from "./dto/finance-ar.schemas";

interface StatementLine {
  date: string;
  type: "invoice" | "payment" | "credit_note";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

interface StatementResult {
  clientId: number;
  clientName: string;
  from: string | null;
  to: string | null;
  openingBalance: number;
  lines: StatementLine[];
  closingBalance: number;
}

@Injectable()
export class StatementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async customerStatement(orgId: string, clientId: number, query: CustomerStatementQuery): Promise<StatementResult | { format: "csv"; content: string; filename: string }> {
    const client = await this.db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.orgId, orgId)),
      columns: { id: true, name: true },
    });
    if (!client) throw new NotFoundException("Client not found");

    const allInvoices = await this.db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, total: invoices.total, createdAt: invoices.createdAt, dueDate: invoices.dueDate })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)));

    const invoiceIds = allInvoices.map((i) => i.id);
    const allPayments = invoiceIds.length > 0
      ? await this.db.select({ id: payments.id, invoiceId: payments.invoiceId, amount: payments.amount, paymentDate: payments.paymentDate, referenceNumber: payments.referenceNumber }).from(payments).where(and(eq(payments.orgId, orgId), inArray(payments.invoiceId, invoiceIds)))
      : [];

    const allCreditNotes = await this.db
      .select({ id: creditNotes.id, creditNoteNumber: creditNotes.creditNoteNumber, appliedAmount: creditNotes.appliedAmount, invoiceId: creditNotes.invoiceId, createdAt: creditNotes.createdAt })
      .from(creditNotes)
      .where(and(eq(creditNotes.orgId, orgId), eq(creditNotes.clientId, clientId)));

    const fromDate = query.from ? new Date(`${query.from}T00:00:00Z`) : null;
    const toDate = query.to ? new Date(`${query.to}T23:59:59Z`) : null;

    const invBeforeFrom = fromDate
      ? allInvoices.filter((i) => i.createdAt && new Date(i.createdAt) < fromDate)
      : [];
    const payBeforeFrom = fromDate
      ? allPayments.filter((p) => p.paymentDate && new Date(`${p.paymentDate}T00:00:00Z`) < fromDate)
      : [];
    const cnBeforeFrom = fromDate
      ? allCreditNotes.filter((c) => c.createdAt && new Date(c.createdAt) < fromDate && Number(c.appliedAmount) > 0)
      : [];

    const openingBalance =
      invBeforeFrom.reduce((acc, i) => acc + Number(i.total ?? 0), 0) -
      payBeforeFrom.reduce((acc, p) => acc + Number(p.amount ?? 0), 0) -
      cnBeforeFrom.reduce((acc, c) => acc + Number(c.appliedAmount ?? 0), 0);

    const filteredInvoices = allInvoices.filter((i) => {
      if (!i.createdAt) return false;
      const d = new Date(i.createdAt);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    const filteredPayments = allPayments.filter((p) => {
      if (!p.paymentDate) return false;
      const d = new Date(`${p.paymentDate}T00:00:00Z`);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    const filteredCreditNotes = allCreditNotes.filter((c) => {
      if (!c.createdAt || Number(c.appliedAmount) === 0) return false;
      const d = new Date(c.createdAt);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    const rawLines: Array<{ date: Date; type: "invoice" | "payment" | "credit_note"; reference: string; description: string; debit: number; credit: number }> = [];

    for (const inv of filteredInvoices) {
      rawLines.push({ date: inv.createdAt ?? new Date(), type: "invoice", reference: inv.invoiceNumber, description: `Invoice ${inv.invoiceNumber}`, debit: Number(inv.total ?? 0), credit: 0 });
    }
    for (const pay of filteredPayments) {
      rawLines.push({ date: new Date(`${pay.paymentDate}T00:00:00Z`), type: "payment", reference: pay.referenceNumber ?? `PMT-${pay.id}`, description: `Payment received`, debit: 0, credit: Number(pay.amount ?? 0) });
    }
    for (const cn of filteredCreditNotes) {
      rawLines.push({ date: cn.createdAt ?? new Date(), type: "credit_note", reference: cn.creditNoteNumber, description: `Credit note applied`, debit: 0, credit: Number(cn.appliedAmount ?? 0) });
    }

    rawLines.sort((a, b) => a.date.getTime() - b.date.getTime());

    let runningBalance = openingBalance;
    const lines: StatementLine[] = rawLines.map((l) => {
      runningBalance = runningBalance + l.debit - l.credit;
      return { date: l.date.toISOString().slice(0, 10), type: l.type, reference: l.reference, description: l.description, debit: l.debit, credit: l.credit, balance: runningBalance };
    });

    const result: StatementResult = { clientId, clientName: client.name, from: query.from ?? null, to: query.to ?? null, openingBalance, lines, closingBalance: runningBalance };

    if (query.format === "csv") {
      const header = "Date,Type,Reference,Description,Debit,Credit,Balance\n";
      const rows = lines.map((l) => `${l.date},${l.type},${l.reference},"${l.description}",${l.debit.toFixed(2)},${l.credit.toFixed(2)},${l.balance.toFixed(2)}`).join("\n");
      return { format: "csv" as const, content: header + rows, filename: `statement-${clientId}-${query.from ?? "all"}.csv` };
    }

    return result;
  }
}
