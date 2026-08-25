import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  clients,
  contacts,
  deals,
  invoices,
  payments,
  projects,
  quotes,
  supportTickets,
  csatSurveys,
} from "../../../db/schema";
import { businessParties, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PARTY_OF_CONTACT, PARTY_OF_LEAD, leadSource, leadStatus } from "../crm-party-reads";

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

  /**
   * The legacy row is still the only place "works at this company" is recorded --
   * `contacts.organization_id` points at `crm_organizations`, and a party's
   * employer cannot point at one until that table converges too. So it stays as
   * the association, and every field on the card comes from the party.
   */
  private contactSection(orgId: string, where: SQL | undefined) {
    return this.db
      .select({
        id: contacts.id,
        name: businessParties.name,
        email: businessParties.email,
        title: businessParties.jobTitle,
        createdAt: businessParties.createdAt,
      })
      .from(contacts)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.contactId, contacts.id),
          eq(contactPartyMap.organizationId, orgId),
        ),
      )
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(where);
  }

  private contactSectionCount(orgId: string, where: SQL | undefined) {
    return this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.contactId, contacts.id),
          eq(contactPartyMap.organizationId, orgId),
        ),
      )
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(where);
  }

  async fetchContacts(orgId: string, companyId: number): Promise<Customer360Section<unknown>> {
    const where = and(
      eq(contacts.orgId, orgId),
      eq(contacts.organizationId, companyId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.contactSection(orgId, where)
        .orderBy(desc(businessParties.createdAt))
        .limit(SECTION_LIMIT),
      this.contactSectionCount(orgId, where).then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  /**
   * Which lead a client converted from.
   *
   * The two client sections below used to filter `leads` on `client_id`, a
   * column `leads` has never had — the section 500ed rather than returning
   * anything. `clients.lead_id` is the link that exists, and it is legacy-owned:
   * a legacy-to-legacy pointer with no Party equivalent until `leads` is
   * dropped, per `party-mirror-fields.ts`.
   */
  private async leadIdOfClient(orgId: string, clientId: number): Promise<number | null> {
    const [row] = await this.db
      .select({ leadId: clients.leadId })
      .from(clients)
      .where(and(eq(clients.orgId, orgId), eq(clients.id, clientId)))
      .limit(1);
    return row?.leadId ?? null;
  }

  async fetchContactsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const leadId = await this.leadIdOfClient(orgId, clientId);
    if (leadId === null) return { items: [], total: 0 };

    const where = and(
      eq(contacts.orgId, orgId),
      eq(contacts.leadId, leadId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.contactSection(orgId, where)
        .orderBy(desc(businessParties.createdAt))
        .limit(SECTION_LIMIT),
      this.contactSectionCount(orgId, where).then((rows) => rows[0]),
    ]);

    return { items, total: Number(countRow?.count ?? 0) };
  }

  private leadSection(where: SQL | undefined) {
    return this.db
      .select({
        id: leadPartyMap.leadId,
        name: businessParties.name,
        status: leadStatus,
        source: leadSource,
        createdAt: businessParties.createdAt,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(where);
  }

  private leadSectionCount(where: SQL | undefined) {
    return this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(where);
  }

  async fetchLeadsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const where = and(
      eq(leadPartyMap.organizationId, orgId),
      sql`${businessParties.companyName} ILIKE ${"%" + safe + "%"}`,
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.leadSection(where).orderBy(desc(businessParties.createdAt)).limit(SECTION_LIMIT),
      this.leadSectionCount(where).then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchLeadsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const leadId = await this.leadIdOfClient(orgId, clientId);
    if (leadId === null) return { items: [], total: 0 };

    const where = and(
      eq(leadPartyMap.organizationId, orgId),
      eq(leadPartyMap.leadId, leadId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.leadSection(where).orderBy(desc(businessParties.createdAt)).limit(SECTION_LIMIT),
      this.leadSectionCount(where).then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

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

  async fetchSupportTicketsForOrg(orgId: string): Promise<Customer360Section<unknown>> {
    const where = eq(supportTickets.orgId, orgId);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
        .from(supportTickets)
        .where(where)
        .orderBy(desc(supportTickets.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
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

  async fetchSurveysForOrg(orgId: string): Promise<Customer360Section<unknown>> {
    const where = eq(csatSurveys.orgId, orgId);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
        .from(csatSurveys)
        .where(where)
        .orderBy(desc(csatSurveys.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(csatSurveys)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
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
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
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
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), eq(deals.clientId, clientId)))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
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
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSignedDocumentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, signedAt: quotes.signedAt, signedDocumentRef: quotes.signedDocumentRef, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }
}
