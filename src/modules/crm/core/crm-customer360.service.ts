import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { contacts, crmOrganizations, deals } from "../../../db/schema";
import { businessParties, clientPartyMap, contactPartyMap, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CLIENT, PARTY_OF_CONTACT, PARTY_OF_LEAD, leadStatus } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { CrmCustomer360SectionsService } from "./crm-customer360-sections.service";
import type { Customer360Response, Customer360Section } from "./crm-customer360-sections.service";

@Injectable()
export class CrmCustomer360Service {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
    private readonly sections: CrmCustomer360SectionsService,
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
      fetchMap.push(["contacts", () => this.sections.fetchContacts(orgId, companyId)]);
    }
    if (permSet.has("crm:leads:view")) {
      fetchMap.push(["leads", () => this.sections.fetchLeadsForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:deals:read")) {
      fetchMap.push(["deals", () => this.sections.fetchDealsForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:quotes:read")) {
      fetchMap.push(["quotes", () => this.sections.fetchQuotesForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:clients:read")) {
      fetchMap.push(["invoices", () => this.sections.fetchInvoicesForOrg(orgId, orgRow.name)]);
      fetchMap.push(["payments", () => this.sections.fetchPaymentsForOrg(orgId)]);
      fetchMap.push(["supportTickets", () => this.sections.fetchSupportTicketsForOrg(orgId)]);
      fetchMap.push(["surveys", () => this.sections.fetchSurveysForOrg(orgId)]);
    }
    if (permSet.has("build:view")) {
      fetchMap.push(["projects", () => this.sections.fetchProjectsForOrg(orgId, orgRow.name)]);
    }
    if (permSet.has("crm:quotes:read")) {
      fetchMap.push(["signedDocuments", () => this.sections.fetchSignedDocumentsForOrg(orgId, orgRow.name)]);
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
      .select({ id: clientPartyMap.clientId, name: businessParties.name })
      .from(clientPartyMap)
      .innerJoin(businessParties, PARTY_OF_CLIENT)
      .where(and(eq(clientPartyMap.clientId, clientId), eq(clientPartyMap.organizationId, orgId)));

    if (!clientRow) return {};

    const fetchMap: Array<[string, () => Promise<Customer360Section<unknown>>]> = [];

    if (permSet.has("crm:contacts:view")) {
      fetchMap.push(["contacts", () => this.sections.fetchContactsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:leads:view")) {
      fetchMap.push(["leads", () => this.sections.fetchLeadsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:deals:read")) {
      fetchMap.push(["deals", () => this.sections.fetchDealsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:clients:read")) {
      fetchMap.push(["invoices", () => this.sections.fetchInvoicesForClient(orgId, clientId)]);
      fetchMap.push(["payments", () => this.sections.fetchPaymentsForClient(orgId, clientId)]);
      fetchMap.push(["supportTickets", () => this.sections.fetchSupportTicketsForClient(orgId, clientId)]);
      fetchMap.push(["surveys", () => this.sections.fetchSurveysForClient(orgId, clientId)]);
    }
    if (permSet.has("build:view")) {
      fetchMap.push(["projects", () => this.sections.fetchProjectsForClient(orgId, clientId)]);
    }
    if (permSet.has("crm:quotes:read")) {
      fetchMap.push(["signedDocuments", () => this.sections.fetchSignedDocumentsForClient(orgId, clientId)]);
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
      // `contacts.organization_id` has no Party column to move to, so the legacy
      // row still says who works at this company; the name and the date on the
      // event come from the party it maps to.
      this.db
        .select({
          id: contacts.id,
          name: businessParties.name,
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
        .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, companyId), sql`${businessParties.createdAt} < ${cursorDate.toISOString()}`))
        .orderBy(desc(businessParties.createdAt))
        .limit(limit),
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), sql`${deals.name} ILIKE ${"%" + safeName + "%"}`, sql`${deals.createdAt} < ${cursorDate.toISOString()}`))
        .orderBy(desc(deals.createdAt))
        .limit(limit),
      this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          status: leadStatus,
          createdAt: businessParties.createdAt,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(
          eq(leadPartyMap.organizationId, orgId),
          sql`${businessParties.companyName} ILIKE ${"%" + safeName + "%"}`,
          isNull(businessParties.deletedAt),
          sql`${businessParties.createdAt} < ${cursorDate.toISOString()}`,
        ))
        .orderBy(desc(businessParties.createdAt))
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
}
