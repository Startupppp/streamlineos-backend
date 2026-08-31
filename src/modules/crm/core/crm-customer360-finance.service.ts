import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { deals, invoices, payments, quotes } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { SECTION_LIMIT, type Customer360Section } from "./crm-customer360-sections.service";

@Injectable()
export class CrmCustomer360FinanceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async fetchDealsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, value: deals.value, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .orderBy(desc(deals.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchDealsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, value: deals.value, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.clientId, clientId)))
        .orderBy(desc(deals.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchQuotesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where = and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
        .from(quotes)
        .where(where)
        .orderBy(desc(quotes.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchQuotesForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const where = and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.clientId, clientId));
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
        .from(quotes)
        .where(where)
        .orderBy(desc(quotes.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchInvoicesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where = and(eq(invoices.orgId, orgId), sql`${invoices.invoiceNumber} ILIKE ${"%" + safe + "%"}`);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, total: invoices.total, createdAt: invoices.createdAt })
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invoices)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchInvoicesForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, total: invoices.total, createdAt: invoices.createdAt })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)))
        .orderBy(desc(invoices.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invoices)
        .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchPaymentsForOrg(orgId: string): Promise<Customer360Section<unknown>> {
    const where = eq(payments.orgId, orgId);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
        .from(payments)
        .where(where)
        .orderBy(desc(payments.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(payments)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchPaymentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const clientInvoiceIds = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)))
      .then((rows) => rows.map((r) => r.id));

    if (clientInvoiceIds.length === 0) return { items: [], total: 0 };

    const paymentsWhere = and(eq(payments.orgId, orgId), inArray(payments.invoiceId, clientInvoiceIds));
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
        .from(payments)
        .where(paymentsWhere)
        .orderBy(desc(payments.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(payments)
        .where(paymentsWhere)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }
}
