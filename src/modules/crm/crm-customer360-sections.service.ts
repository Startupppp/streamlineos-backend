import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  contacts,
  clients,
  deals,
  leads,
  invoices,
  payments,
  projects,
  quotes,
  supportTickets,
  csatSurveys,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

export const SECTION_LIMIT = 10;

export interface Customer360Section<T> {
  items: T[];
  total: number;
}

export interface Customer360Response {
  contacts?: Customer360Section<unknown>;
  leads?: Customer360Section<unknown>;
  deals?: Customer360Section<unknown>;
  quotes?: Customer360Section<unknown>;
  invoices?: Customer360Section<unknown>;
  payments?: Customer360Section<unknown>;
  supportTickets?: Customer360Section<unknown>;
  surveys?: Customer360Section<unknown>;
  activities?: Customer360Section<unknown>;
  projects?: Customer360Section<unknown>;
  signedDocuments?: Customer360Section<unknown>;
}

@Injectable()
export class CrmCustomer360SectionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async fetchContacts(orgId: string, companyId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, createdAt: contacts.createdAt })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, companyId), isNull(contacts.deletedAt)))
        .orderBy(desc(contacts.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, companyId), isNull(contacts.deletedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchContactsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const leadIds = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), sql`client_id = ${clientId}`))
      .then((rows) => rows.map((r) => r.id));

    if (leadIds.length === 0) return { items: [], total: 0 };

    const items = await this.db
      .select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, createdAt: contacts.createdAt })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), inArray(contacts.leadId, leadIds), isNull(contacts.deletedAt)))
      .orderBy(desc(contacts.createdAt))
      .limit(SECTION_LIMIT);

    return { items, total: items.length };
  }

  async fetchLeadsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: leads.id, name: leads.name, status: leads.status, source: leads.source, createdAt: leads.createdAt })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), sql`${leads.company} ILIKE ${"%" + safe + "%"}`, isNull(leads.deletedAt)))
        .orderBy(desc(leads.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), sql`${leads.company} ILIKE ${"%" + safe + "%"}`, isNull(leads.deletedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchLeadsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: leads.id, name: leads.name, status: leads.status, source: leads.source, createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), sql`client_id = ${clientId}`, isNull(leads.deletedAt)))
      .orderBy(desc(leads.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchDealsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, value: deals.value, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .orderBy(desc(deals.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchDealsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, value: deals.value, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.clientId, clientId)))
        .orderBy(desc(deals.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchQuotesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const items = await this.db
      .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
      .orderBy(desc(quotes.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchQuotesForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.clientId, clientId)))
      .orderBy(desc(quotes.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchInvoicesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const items = await this.db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, total: invoices.total, createdAt: invoices.createdAt })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), sql`${invoices.invoiceNumber} ILIKE ${"%" + safe + "%"}`))
      .orderBy(desc(invoices.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
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

  async fetchPaymentsForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
      .from(payments)
      .where(eq(payments.orgId, orgId))
      .orderBy(desc(payments.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchPaymentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const clientInvoiceIds = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)))
      .then((rows) => rows.map((r) => r.id));

    if (clientInvoiceIds.length === 0) return { items: [], total: 0 };

    const items = await this.db
      .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), inArray(payments.invoiceId, clientInvoiceIds)))
      .orderBy(desc(payments.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchSupportTicketsForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId))
      .orderBy(desc(supportTickets.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchSupportTicketsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
        .from(supportTickets)
        .where(and(eq(supportTickets.orgId, orgId), eq(supportTickets.clientId, clientId)))
        .orderBy(desc(supportTickets.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(and(eq(supportTickets.orgId, orgId), eq(supportTickets.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSurveysForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
      .from(csatSurveys)
      .where(eq(csatSurveys.orgId, orgId))
      .orderBy(desc(csatSurveys.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  async fetchSurveysForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
        .from(csatSurveys)
        .where(and(eq(csatSurveys.orgId, orgId), eq(csatSurveys.clientId, clientId)))
        .orderBy(desc(csatSurveys.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(csatSurveys)
        .where(and(eq(csatSurveys.orgId, orgId), eq(csatSurveys.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchProjectsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: projects.id, name: projects.name, status: projects.status, startDate: projects.startDate, endDate: projects.endDate, createdAt: projects.createdAt })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .where(and(eq(projects.orgId, orgId)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .where(and(eq(projects.orgId, orgId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchProjectsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: projects.id, name: projects.name, status: projects.status, startDate: projects.startDate, endDate: projects.endDate, createdAt: projects.createdAt })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), eq(deals.clientId, clientId)))
        .where(and(eq(projects.orgId, orgId)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), eq(deals.clientId, clientId)))
        .where(and(eq(projects.orgId, orgId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSignedDocumentsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, signedAt: quotes.signedAt, signedDocumentRef: quotes.signedDocumentRef, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSignedDocumentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, signedAt: quotes.signedAt, signedDocumentRef: quotes.signedDocumentRef, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }
}
