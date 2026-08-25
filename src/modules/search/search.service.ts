import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, ilike, isNull, or, sql } from "drizzle-orm";
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
 * Leads, contacts and clients are found through `*_party_map ⨝ business_parties`
 * rather than through the legacy tables: the mirror is derived, so a search over
 * it can only ever be as fresh as the last write that refreshed it, and ticket 08
 * removes it entirely. The trigram indexes 0275 put on `business_parties.name`,
 * `.email`, `.phone` and `.company_name` are what these ILIKEs land on now, so
 * no index on a legacy table is in a position to answer a search at all.
 *
 * `contacts` is still imported, for `lead_id` and `deal_id` only. Those are the
 * associations that scope a contact, they are legacy-owned columns with no Party
 * equivalent yet (see `LEGACY_OWNED_COLUMNS`), and no name, address or number is
 * read from that join.
 */

export type SearchResultType = "lead" | "deal" | "contact" | "client" | "ticket";

/**
 * The lead's Party, under a second name.
 *
 * The contact scope asks who owns the lead a contact came from, inside a
 * subquery whose outer query is already selecting from `business_parties`. Two
 * references to one table need two names, or the correlated predicate binds to
 * the wrong one.
 */
const leadOwnerParty = alias(businessParties, "search_lead_owner_party");

const LEAD_OWNER_PARTY_JOIN = and(
  eq(leadOwnerParty.partyId, leadPartyMap.partyId),
  eq(leadOwnerParty.organizationId, leadPartyMap.organizationId),
);

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

  private async executeSearch(
    user: CurrentUserContext,
    access: SearchAccess,
    q: string,
    limit: number | undefined,
  ): Promise<SearchResponse> {
    const { orgId, userId } = user;
    const maxPer = Math.min(limit ?? 5, 10);
    const pattern = `%${q}%`;
    const trimmed = q.trim();
    const numericTicket = /^\d+$/.test(trimmed) ? Number(trimmed) : null;

    const ticketConditions = [
      ilike(tickets.title, pattern),
      ilike(sql`${projects.key} || '-' || ${tickets.ticketNumber}::text`, pattern),
    ];
    if (numericTicket !== null) {
      ticketConditions.push(eq(tickets.ticketNumber, numericTicket));
    }
    const ticketWhere = or(...ticketConditions);
    const contactAccess = access.contacts;
    /*
     * A contact is scoped by the lead it came from or the deal it sits on --
     * `contacts` is the only place that association lives, and a contact-shaped
     * party has no owner of its own to scope by. The *owner* is read from the
     * lead's Party rather than from `leads.assigned_to_id`: a mirror column
     * deciding who may see a record is the one place a lagging copy would be a
     * disclosure rather than a display glitch.
     */
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
              ilike(businessParties.companyName, pattern),
              ilike(businessParties.phone, pattern),
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
            or(ilike(deals.name, pattern), ilike(deals.contactPerson, pattern)),
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
        // Joined back for `lead_id` and `deal_id` alone, which the scope reads
        // and Party has no column for. One row per contact either way: the join
        // is on the map's own primary key.
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
            or(
              ilike(businessParties.name, pattern),
              ilike(businessParties.email, pattern),
              ilike(businessParties.companyName, pattern),
            ),
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
          // `clients.status` mirrors the record's own status, not the pipeline
          // stage, and Party declares it NOT NULL -- so no coalesce here.
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
            or(ilike(businessParties.name, pattern), ilike(businessParties.companyName, pattern)),
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
