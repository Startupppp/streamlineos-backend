import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { contacts, deals, projects, tickets } from "../../db/schema";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  leadPartyMap,
} from "../../db/schema/party";
import { PARTY_OF_CLIENT, PARTY_OF_CONTACT, PARTY_OF_LEAD, leadStatus } from "../crm/crm-party-reads";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { applyScope } from "../access/apply-scope";
import { authorize, type AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";

/**
 * Global search, reading identity from Party.
 *
 * Under RLS the `textlike` operator behind ILIKE is not leakproof, so the
 * planner skips the GIN/trigram index entirely. Each branch resolves candidates
 * through a SECURITY DEFINER id-probe (migrations 0275, 0425, 0475) owned by
 * the BYPASSRLS role. The probe returns ids only; the caller's query still runs
 * under RLS with its own DataScope and scope predicate. When the probe returns
 * more than the cap the term is too broad for an id list to pay for itself and
 * the branch falls back to plain ILIKE — independently of the other branches.
 */

export type SearchResultType = "lead" | "deal" | "contact" | "client" | "ticket";

const leadOwnerParty = alias(businessParties, "search_lead_owner_party");

const LEAD_OWNER_PARTY_JOIN = and(
  eq(leadOwnerParty.partyId, leadPartyMap.partyId),
  eq(leadOwnerParty.organizationId, leadPartyMap.organizationId),
);

const PARTY_SEARCH_CAP = 500;
const DEAL_SEARCH_CAP = 500;
const TICKET_ID_CAP = 1000;

export interface SearchResult {
  id: number;
  type: SearchResultType;
  title: string;
  subtitle: string;
  href: string;
  status?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface SearchAccess {
  leads: DataScope | null;
  deals: DataScope | null;
  contacts: DataScope | null;
  clients: DataScope | null;
  build: DataScope | null;
}

export async function resolveSearchAccess(
  access: AccessResolver,
  user: CurrentUserContext,
): Promise<SearchAccess> {
  const [leadResult, dealResult, contactResult, clientResult, buildResult] =
    await Promise.all([
      authorize(access, user, "crm:leads:view"),
      authorize(access, user, "crm:deals:read"),
      authorize(access, user, "crm:contacts:view"),
      authorize(access, user, "crm:clients:read"),
      authorize(access, user, "build:tickets:view"),
    ]);
  return {
    leads: leadResult.allow ? leadResult.scope : null,
    deals: dealResult.allow ? dealResult.scope : null,
    contacts: contactResult.allow ? contactResult.scope : null,
    clients: clientResult.allow ? clientResult.scope : null,
    build: buildResult.allow ? buildResult.scope : null,
  };
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async search(
    user: CurrentUserContext,
    q: string,
    limit: number | undefined,
  ): Promise<SearchResponse> {
    const trimmed = q.trim();
    if (!trimmed) return { results: [], total: 0 };
    const [searchAccess, version] = await Promise.all([
      resolveSearchAccess(this.access, user),
      this.access.getPermissionsVersion(user.orgId),
    ]);
    const queryHash = Buffer.from(`${trimmed}:${limit ?? ""}:v${version}`)
      .toString("base64url")
      .slice(0, 32);
    return this.cache.cached(
      CACHE_KEYS.searchResults(user.orgId, user.userId, queryHash),
      () => this.executeSearch(user, searchAccess, trimmed, limit),
      CACHE_TTL.SHORT,
    );
  }

  private async leadCompanyCondition(q: string, pattern: string): Promise<SQL<unknown>> {
    const rows = await this.db.execute(
      sql`SELECT app.search_party_ids_by_company(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > PARTY_SEARCH_CAP) return ilike(businessParties.companyName, pattern);
    if (rows.length === 0) return sql`false`;
    return inArray(businessParties.partyId, rows.map((r) => String(r["id"])));
  }

  private async dealCondition(q: string, pattern: string): Promise<SQL<unknown>> {
    const fallback = or(ilike(deals.name, pattern), ilike(deals.contactPerson, pattern)) ?? sql`false`;
    const rows = await this.db.execute(
      sql`SELECT app.search_deal_ids(${q}, ${DEAL_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > DEAL_SEARCH_CAP) return fallback;
    if (rows.length === 0) return sql`false`;
    return inArray(deals.id, rows.map((r) => Number(r["id"])));
  }

  private async contactPartyCondition(q: string, pattern: string): Promise<SQL<unknown>> {
    const fallback =
      or(
        ilike(businessParties.name, pattern),
        ilike(businessParties.email, pattern),
        ilike(businessParties.companyName, pattern),
      ) ?? sql`false`;
    const rows = await this.db.execute(
      sql`SELECT app.search_contact_party_ids(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > PARTY_SEARCH_CAP) return fallback;
    if (rows.length === 0) return sql`false`;
    return inArray(businessParties.partyId, rows.map((r) => String(r["id"])));
  }

  private async clientPartyCondition(q: string, pattern: string): Promise<SQL<unknown>> {
    const fallback =
      or(ilike(businessParties.name, pattern), ilike(businessParties.companyName, pattern)) ?? sql`false`;
    const rows = await this.db.execute(
      sql`SELECT app.search_client_party_ids(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > PARTY_SEARCH_CAP) return fallback;
    if (rows.length === 0) return sql`false`;
    return inArray(businessParties.partyId, rows.map((r) => String(r["id"])));
  }

  private async ticketTitleCondition(q: string, pattern: string): Promise<SQL<unknown>> {
    const rows = await this.db.execute(
      sql`SELECT app.search_ticket_ids(${q}, ${TICKET_ID_CAP + 1}) AS id`,
    );
    if (rows.length > TICKET_ID_CAP) return ilike(tickets.title, pattern);
    if (rows.length === 0) return sql`false`;
    return inArray(tickets.id, rows.map((r) => Number(r["id"])));
  }

  private async executeSearch(
    user: CurrentUserContext,
    access: SearchAccess,
    q: string,
    limit: number | undefined,
  ): Promise<SearchResponse> {
    const { orgId, userId } = user;
    const maxPer = Math.min(limit ?? 5, 10);
    const pattern = `%${q}%`;

    const keyMatch = /^([A-Za-z]+)-(\d+)$/.exec(q);
    const numericTicket = /^\d+$/.test(q) ? Number(q) : null;
    const needsTicketProbe = access.build !== null && keyMatch === null && numericTicket === null;

    const contactAccess = access.contacts;
    const contactScope =
      contactAccess === "all"
        ? sql`true`
        : contactAccess
          ? or(
              exists(
                this.db
                  .select({ value: sql`1` })
                  .from(leadPartyMap)
                  .innerJoin(leadOwnerParty, LEAD_OWNER_PARTY_JOIN)
                  .where(
                    and(
                      eq(leadPartyMap.organizationId, orgId),
                      eq(leadPartyMap.leadId, contacts.leadId),
                      applyScope(contactAccess, orgId, userId, {
                        ownerColumn: leadOwnerParty.ownerUserId,
                      }),
                    ),
                  ),
              ),
              exists(
                this.db
                  .select({ value: sql`1` })
                  .from(deals)
                  .where(
                    and(
                      eq(deals.orgId, orgId), isNull(deals.deletedAt),
                      eq(deals.id, contacts.dealId),
                      applyScope(contactAccess, orgId, userId, {
                        ownerColumn: deals.assignedToId,
                      }),
                    ),
                  ),
              ),
            )
          : sql`false`;

    const [leadCompanyCond, dealCond, contactCond, clientCond, ticketTitleCond] = await Promise.all([
      access.leads ? this.leadCompanyCondition(q, pattern) : Promise.resolve(sql`false`),
      access.deals ? this.dealCondition(q, pattern) : Promise.resolve(sql`false`),
      access.contacts ? this.contactPartyCondition(q, pattern) : Promise.resolve(sql`false`),
      access.clients ? this.clientPartyCondition(q, pattern) : Promise.resolve(sql`false`),
      needsTicketProbe ? this.ticketTitleCondition(q, pattern) : Promise.resolve(sql`false`),
    ]);

    const ticketKey = keyMatch?.[1];
    const ticketNumStr = keyMatch?.[2];
    const ticketWhere =
      ticketKey !== undefined && ticketNumStr !== undefined
        ? and(ilike(projects.key, ticketKey), eq(tickets.ticketNumber, Number(ticketNumStr))) ?? sql`false`
        : numericTicket !== null
          ? eq(tickets.ticketNumber, numericTicket)
          : ticketTitleCond;

    const [leadResults, dealResults, contactResults, clientResults, ticketResults] = await Promise.all([
      access.leads
        ? this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          email: businessParties.email,
          company: businessParties.companyName,
          status: leadStatus,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(
          and(
            eq(leadPartyMap.organizationId, orgId),
            eq(businessParties.organizationId, orgId),
            isNull(businessParties.deletedAt),
            applyScope(access.leads, orgId, userId, {
              ownerColumn: businessParties.ownerUserId,
            }),
            or(
              ilike(businessParties.name, pattern),
              ilike(businessParties.email, pattern),
              ilike(businessParties.phone, pattern),
              leadCompanyCond,
            ),
          ),
        )
        .orderBy(desc(businessParties.updatedAt), desc(leadPartyMap.leadId))
        .limit(maxPer)
        : Promise.resolve([]),

      access.deals
        ? this.db
        .select({ id: deals.id, name: deals.name, value: deals.value, stage: deals.stage, contactPerson: deals.contactPerson })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId), isNull(deals.deletedAt),
            applyScope(access.deals, orgId, userId, {
              ownerColumn: deals.assignedToId,
            }),
            dealCond,
          ),
        )
        .limit(maxPer)
        : Promise.resolve([]),

      access.contacts
        ? this.db
        .select({
          id: contactPartyMap.contactId,
          name: businessParties.name,
          email: businessParties.email,
          company: businessParties.companyName,
        })
        .from(contactPartyMap)
        .innerJoin(businessParties, PARTY_OF_CONTACT)
        .innerJoin(
          contacts,
          and(eq(contacts.id, contactPartyMap.contactId), eq(contacts.orgId, contactPartyMap.organizationId)),
        )
        .where(
          and(
            eq(contactPartyMap.organizationId, orgId),
            eq(businessParties.organizationId, orgId),
            isNull(businessParties.deletedAt),
            contactScope,
            contactCond,
          ),
        )
        .orderBy(desc(businessParties.updatedAt), desc(contactPartyMap.contactId))
        .limit(maxPer)
        : Promise.resolve([]),

      access.clients
        ? this.db
        .select({
          id: clientPartyMap.clientId,
          name: businessParties.name,
          company: businessParties.companyName,
          status: businessParties.status,
        })
        .from(clientPartyMap)
        .innerJoin(businessParties, PARTY_OF_CLIENT)
        .where(
          and(
            eq(clientPartyMap.organizationId, orgId),
            eq(businessParties.organizationId, orgId),
            isNull(businessParties.deletedAt),
            applyScope(access.clients, orgId, userId, {
              ownerColumn: businessParties.ownerUserId,
            }),
            clientCond,
          ),
        )
        .orderBy(desc(businessParties.updatedAt), desc(clientPartyMap.clientId))
        .limit(maxPer)
        : Promise.resolve([]),

      access.build
        ? this.db
        .select({
          id: tickets.id,
          title: tickets.title,
          status: tickets.status,
          projectId: tickets.projectId,
          ticketNumber: tickets.ticketNumber,
          projectKey: projects.key,
        })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(projects.orgId, orgId),
            isNull(tickets.deletedAt),
            applyScope(access.build, orgId, userId, {
              ownerColumn: tickets.assigneeId,
            }),
            ticketWhere,
          ),
        )
        .limit(maxPer)
        : Promise.resolve([]),
    ]);

    const results: SearchResult[] = [
      ...leadResults.map((l): SearchResult => ({
        id: l.id,
        type: "lead",
        title: l.name,
        subtitle: [l.email, l.company].filter(Boolean).join(" · ") || "Lead",
        href: `/crm/leads/${l.id}`,
        status: l.status,
      })),
      ...dealResults.map((d): SearchResult => ({
        id: d.id,
        type: "deal",
        title: d.name,
        subtitle: d.contactPerson || `₹${d.value || 0}`,
        href: `/crm/deals/${d.id}`,
        status: d.stage,
      })),
      ...contactResults.map((c): SearchResult => ({
        id: c.id,
        type: "contact",
        title: c.name,
        subtitle: [c.email, c.company].filter(Boolean).join(" · ") || "Contact",
        href: `/crm/contacts`,
      })),
      ...clientResults.map((c): SearchResult => ({
        id: c.id,
        type: "client",
        title: c.name,
        subtitle: c.company || "Client",
        href: `/crm/clients/${c.id}`,
        status: c.status,
      })),
      ...ticketResults.map((t): SearchResult => ({
        id: t.id,
        type: "ticket",
        title: t.title,
        subtitle: `${t.projectKey}-${t.ticketNumber}`,
        href: `/projects/${t.projectId}?ticket=${t.id}`,
        status: t.status,
      })),
    ];

    return { results, total: results.length };
  }
}
