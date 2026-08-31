import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { businessParties, clientPartyMap, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PARTY_OF_CLIENT, PARTY_OF_CONTACT, PARTY_OF_LEAD, leadSource, leadStatus } from "../crm-party-reads";
import { partyIdsOfCrmOrgs } from "../../party/party-legacy-employer";
import { CrmCustomer360FinanceService } from "./crm-customer360-finance.service";
import { CrmCustomer360EngagementService } from "./crm-customer360-engagement.service";

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly finance: CrmCustomer360FinanceService,
    private readonly engagement: CrmCustomer360EngagementService,
  ) {}

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
    const employerPartyId = (await partyIdsOfCrmOrgs(this.db, orgId, [companyId])).get(companyId);
    if (!employerPartyId) return { items: [], total: 0 };

    const where = and(
      eq(contactPartyMap.organizationId, orgId),
      eq(businessParties.employerPartyId, employerPartyId),
      isNull(businessParties.deletedAt),
    );
    const [items, countRow] = await Promise.all([
      this.contactSection(where).orderBy(desc(businessParties.createdAt)).limit(SECTION_LIMIT),
      this.contactSectionCount(where).then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

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
      .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.partyId, row.partyId)))
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
      this.contactSection(where).orderBy(desc(businessParties.createdAt)).limit(SECTION_LIMIT),
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

  fetchDealsForOrg(orgId: string, orgName: string) { return this.finance.fetchDealsForOrg(orgId, orgName); }
  fetchDealsForClient(orgId: string, clientId: number) { return this.finance.fetchDealsForClient(orgId, clientId); }
  fetchQuotesForOrg(orgId: string, orgName: string) { return this.finance.fetchQuotesForOrg(orgId, orgName); }
  fetchQuotesForClient(orgId: string, clientId: number) { return this.finance.fetchQuotesForClient(orgId, clientId); }
  fetchInvoicesForOrg(orgId: string, orgName: string) { return this.finance.fetchInvoicesForOrg(orgId, orgName); }
  fetchInvoicesForClient(orgId: string, clientId: number) { return this.finance.fetchInvoicesForClient(orgId, clientId); }
  fetchPaymentsForOrg(orgId: string) { return this.finance.fetchPaymentsForOrg(orgId); }
  fetchPaymentsForClient(orgId: string, clientId: number) { return this.finance.fetchPaymentsForClient(orgId, clientId); }
  fetchSupportTicketsForOrg(orgId: string) { return this.engagement.fetchSupportTicketsForOrg(orgId); }
  fetchSupportTicketsForClient(orgId: string, clientId: number) { return this.engagement.fetchSupportTicketsForClient(orgId, clientId); }
  fetchSurveysForOrg(orgId: string) { return this.engagement.fetchSurveysForOrg(orgId); }
  fetchSurveysForClient(orgId: string, clientId: number) { return this.engagement.fetchSurveysForClient(orgId, clientId); }
  fetchProjectsForOrg(orgId: string, orgName: string) { return this.engagement.fetchProjectsForOrg(orgId, orgName); }
  fetchProjectsForClient(orgId: string, clientId: number) { return this.engagement.fetchProjectsForClient(orgId, clientId); }
  fetchSignedDocumentsForOrg(orgId: string, orgName: string) { return this.engagement.fetchSignedDocumentsForOrg(orgId, orgName); }
  fetchSignedDocumentsForClient(orgId: string, clientId: number) { return this.engagement.fetchSignedDocumentsForClient(orgId, clientId); }
}
