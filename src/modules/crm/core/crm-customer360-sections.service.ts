import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  deals,
  invoices,
  payments,
  projects,
  quotes,
  supportTickets,
  csatSurveys,
} from "../../../db/schema";
import { businessParties, clientPartyMap, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PARTY_OF_CLIENT, PARTY_OF_CONTACT, PARTY_OF_LEAD, leadSource, leadStatus } from "../crm-party-reads";
import { partyIdsOfCrmOrgs } from "../../party/party-legacy-employer";

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
   * Every field on a contact card, and both of its associations, from the party.
   *
   * "Works at this company" is `employer_party_id` (0262) and "came from this
   * lead" is `converted_from_party_id` (0265), so the legacy row is not joined at
   * all -- the map leads and supplies the numeric id the card links to.
   */
  private contactSection(where: SQL | undefined) {
    return this.db
      .select({
        id: contactPartyMap.contactId,
        name: businessParties.name,
        email: businessParties.email,
        title: businessParties.jobTitle,
        createdAt: businessParties.createdAt,
      })
      .from(contactPartyMap)
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(where);
  }

  private contactSectionCount(where: SQL | undefined) {
    return this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(contactPartyMap)
      .innerJoin(businessParties, PARTY_OF_CONTACT)
      .where(where);
  }

  async fetchContacts(orgId: string, companyId: number): Promise<Customer360Section<unknown>> {
    // The company id is turned into the party it means once, rather than joining
    // `crm_org_party_map` in: the predicate then sits on `employer_party_id`,
    // which is indexed, and a company with no party returns nothing -- which is
    // what filtering on an unknown company has always done.
    const employerPartyId = (await partyIdsOfCrmOrgs(this.db, orgId, [companyId])).get(companyId);
    if (!employerPartyId) return { items: [], total: 0 };

    const where = and(
      eq(contactPartyMap.organizationId, orgId),
      eq(businessParties.employerPartyId, employerPartyId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.contactSection(where)
        .orderBy(desc(businessParties.createdAt))
        .limit(SECTION_LIMIT),
      this.contactSectionCount(where).then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  /**
   * Which lead a client converted from, as both of the things a caller needs.
   *
   * The two client sections below used to filter `leads` on `client_id`, a
   * column `leads` has never had — the section 500ed rather than returning
   * anything. `clients.lead_id` is the link that exists, and 0265 moved it onto
   * the party as `converted_from_party_id`.
   *
   * Both forms come back because the two callers ask different questions of it.
   * The contacts section wants the party, so it can compare links to links. The
   * leads section wants the integer id, because filtering on the party would
   * return one row per legacy lead id the party answers to — several, after a
   * merge — where it has always returned at most one.
   */
  private async sourceLeadOfClient(
    orgId: string,
    clientId: number,
  ): Promise<{ partyId: string; leadId: number | null } | null> {
    const [row] = await this.db
      .select({ partyId: businessParties.convertedFromPartyId })
      .from(clientPartyMap)
      .innerJoin(businessParties, PARTY_OF_CLIENT)
      .where(and(eq(clientPartyMap.organizationId, orgId), eq(clientPartyMap.clientId, clientId)))
      .limit(1);
    if (!row?.partyId) return null;

    const [mapped] = await this.db
      .select({ leadId: leadPartyMap.leadId })
      .from(leadPartyMap)
      .where(
        and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.partyId, row.partyId)),
      )
      // Lowest id wins where a party answers to several, which happens after a
      // merge re-points the loser's map row. Same rule the mirror writes the
      // legacy column with, so the two cannot give different answers.
      .orderBy(asc(leadPartyMap.leadId))
      .limit(1);

    return { partyId: row.partyId, leadId: mapped?.leadId ?? null };
  }

  async fetchContactsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const source = await this.sourceLeadOfClient(orgId, clientId);
    if (!source) return { items: [], total: 0 };

    const where = and(
      eq(contactPartyMap.organizationId, orgId),
      eq(businessParties.convertedFromPartyId, source.partyId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.contactSection(where)
        .orderBy(desc(businessParties.createdAt))
        .limit(SECTION_LIMIT),
      this.contactSectionCount(where).then((rows) => rows[0]),
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
    const leadId = (await this.sourceLeadOfClient(orgId, clientId))?.leadId ?? null;
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
