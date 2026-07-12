import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  contacts,
  crmOrganizations,
  clients,
  deals,
  leads,
  invoices,
  payments,
  quotes,
  supportTickets,
  csatSurveys,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

const PERMISSION_SECTION_MAP: Record<string, string> = {
  "crm:deals:read": "deals",
  "crm:contacts:view": "contacts",
  "crm:leads:view": "leads",
  "crm:quotes:read": "quotes",
  "crm:clients:read": "invoices",
  "crm:clients:read_payments": "payments",
  "crm:customer360:view": "activities",
};

const SECTION_LIMIT = 10;

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
}

@Injectable()
export class CrmCustomer360Service {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
  ) {}

  async getCompany360(orgId: string, companyId: number, userId: string): Promise<Customer360Response> {
    const permissions = await this.access.resolveUserPermissions(orgId, userId);
    const permSet = new Set(Object.keys(permissions));

    const [orgRow] = await this.db
      .select({ id: crmOrganizations.id, name: crmOrganizations.name })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, companyId), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)));

    if (!orgRow) return {};

    const fetchMap: Array<[string, () => Promise<Customer360Section<unknown>>]> = [];

    if (permSet.has("crm:contacts:view")) {
      fetchMap.push(["contacts", () => this.fetchContacts(orgId, companyId)]);
    }
    if (permSet.has("crm:leads:view")) {
      fetchMap.push(["leads", () => this.fetchLeadsForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:deals:read")) {
      fetchMap.push(["deals", () => this.fetchDealsForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:quotes:read")) {
      fetchMap.push(["quotes", () => this.fetchQuotesForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:clients:read")) {
      fetchMap.push(["invoices", () => this.fetchInvoicesForOrg(orgId, orgRow.name)]);
      fetchMap.push(["payments", () => this.fetchPaymentsForOrg(orgId, orgRow.name)]);
      fetchMap.push(["supportTickets", () => this.fetchSupportTicketsForOrg(orgId, orgRow.name)]);
      fetchMap.push(["surveys", () => this.fetchSurveysForOrg(orgId, orgRow.name)]);
    }

    const results = await Promise.all(fetchMap.map(([, fn]) => fn()));
    const response: Customer360Response = {};
    fetchMap.forEach(([key], idx) => {
      (response as Record<string, unknown>)[key] = results[idx];
    });
    return response;
  }

  async getClient360(orgId: string, clientId: number, userId: string): Promise<Customer360Response> {
    const permissions = await this.access.resolveUserPermissions(orgId, userId);
    const permSet = new Set(Object.keys(permissions));

    const [clientRow] = await this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)));

    if (!clientRow) return {};

    const fetchMap: Array<[string, () => Promise<Customer360Section<unknown>>]> = [];

    if (permSet.has("crm:contacts:view")) {
      fetchMap.push(["contacts", () => this.fetchContactsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:leads:view")) {
      fetchMap.push(["leads", () => this.fetchLeadsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:deals:read")) {
      fetchMap.push(["deals", () => this.fetchDealsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:clients:read")) {
      fetchMap.push(["invoices", () => this.fetchInvoicesForClient(orgId, clientId)]);
      fetchMap.push(["payments", () => this.fetchPaymentsForClient(orgId, clientId)]);
      fetchMap.push(["supportTickets", () => this.fetchSupportTicketsForClient(orgId, clientId)]);
      fetchMap.push(["surveys", () => this.fetchSurveysForClient(orgId, clientId)]);
    }

    const results = await Promise.all(fetchMap.map(([, fn]) => fn()));
    const response: Customer360Response = {};
    fetchMap.forEach(([key], idx) => {
      (response as Record<string, unknown>)[key] = results[idx];
    });
    return response;
  }

  async getCompanyTimeline(orgId: string, companyId: number, cursor?: string) {
    const cacheKey = `crm:customer360:company:${orgId}:${companyId}:timeline:${cursor ?? "start"}`;
    return this.cache.cached(
      cacheKey,
      () => this.buildCompanyTimeline(orgId, companyId, cursor),
      CACHE_TTL.SHORT,
    );
  }

  private async buildCompanyTimeline(orgId: string, companyId: number, cursor?: string) {
    const limit = 20;
    const cursorDate = cursor ? new Date(cursor) : new Date();

    const [orgRow] = await this.db
      .select({ name: crmOrganizations.name })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, companyId), eq(crmOrganizations.orgId, orgId)));

    if (!orgRow) return { items: [], nextCursor: null };

    const safeName = orgRow.name.replaceAll("%", "\\%").replaceAll("_", "\\_");

    const [contactRows, dealRows, leadRows] = await Promise.all([
      this.db
        .select({
          id: contacts.id,
          name: contacts.name,
          createdAt: contacts.createdAt,
        })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, companyId), sql`${contacts.createdAt} < ${cursorDate}`))
        .orderBy(desc(contacts.createdAt))
        .limit(limit),
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), sql`${deals.name} ILIKE ${"%" + safeName + "%"}`, sql`${deals.createdAt} < ${cursorDate}`))
        .orderBy(desc(deals.createdAt))
        .limit(limit),
      this.db
        .select({ id: leads.id, name: leads.name, status: leads.status, createdAt: leads.createdAt })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), sql`${leads.company} ILIKE ${"%" + safeName + "%"}`, isNull(leads.deletedAt), sql`${leads.createdAt} < ${cursorDate}`))
        .orderBy(desc(leads.createdAt))
        .limit(limit),
    ]);

    const events = [
      ...contactRows.map((r) => ({
        type: "contact_created" as const,
        entityId: r.id,
        label: r.name,
        meta: null,
        date: r.createdAt?.toISOString() ?? new Date().toISOString(),
      })),
      ...dealRows.map((r) => ({
        type: "deal_created" as const,
        entityId: r.id,
        label: r.name,
        meta: r.stage,
        date: r.createdAt?.toISOString() ?? new Date().toISOString(),
      })),
      ...leadRows.map((r) => ({
        type: "lead_linked" as const,
        entityId: r.id,
        label: r.name ?? "Unnamed",
        meta: r.status,
        date: r.createdAt?.toISOString() ?? new Date().toISOString(),
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, limit);

    const nextCursor = events.length === limit ? events[events.length - 1]?.date ?? null : null;
    return { items: events, nextCursor };
  }

  private async fetchContacts(orgId: string, companyId: number): Promise<Customer360Section<unknown>> {
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

  private async fetchContactsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const leadIds = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), sql`client_id = ${clientId}`))
      .then((rows) => rows.map((r) => r.id));

    if (leadIds.length === 0) return { items: [], total: 0 };

    const items = await this.db
      .select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, createdAt: contacts.createdAt })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), sql`${contacts.leadId} = ANY(ARRAY[${sql.join(leadIds.map((id) => sql`${id}`), sql`, `)}]::int[])`, isNull(contacts.deletedAt)))
      .orderBy(desc(contacts.createdAt))
      .limit(SECTION_LIMIT);

    return { items, total: items.length };
  }

  private async fetchLeadsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
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

  private async fetchLeadsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: leads.id, name: leads.name, status: leads.status, source: leads.source, createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), sql`client_id = ${clientId}`, isNull(leads.deletedAt)))
      .orderBy(desc(leads.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchDealsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
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

  private async fetchDealsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
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

  private async fetchQuotesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const items = await this.db
      .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
      .orderBy(desc(quotes.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchInvoicesForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const items = await this.db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, total: invoices.total, createdAt: invoices.createdAt })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), sql`${invoices.invoiceNumber} ILIKE ${"%" + safe + "%"}`))
      .orderBy(desc(invoices.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchInvoicesForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
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

  private async fetchPaymentsForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
      .from(payments)
      .where(eq(payments.orgId, orgId))
      .orderBy(desc(payments.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchPaymentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const clientInvoiceIds = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.clientId, clientId)))
      .then((rows) => rows.map((r) => r.id));

    if (clientInvoiceIds.length === 0) return { items: [], total: 0 };

    const items = await this.db
      .select({ id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate, paymentMethod: payments.paymentMethod, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), sql`${payments.invoiceId} = ANY(ARRAY[${sql.join(clientInvoiceIds.map((id) => sql`${id}`), sql`, `)}]::int[])`))
      .orderBy(desc(payments.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchSupportTicketsForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId))
      .orderBy(desc(supportTickets.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchSupportTicketsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
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

  private async fetchSurveysForOrg(orgId: string, _orgName: string): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
      .from(csatSurveys)
      .where(eq(csatSurveys.orgId, orgId))
      .orderBy(desc(csatSurveys.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }

  private async fetchSurveysForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
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

  private async fetchQuotesForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const items = await this.db
      .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, createdAt: quotes.createdAt })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.clientId, clientId)))
      .orderBy(desc(quotes.createdAt))
      .limit(SECTION_LIMIT);
    return { items, total: items.length };
  }
}
