import { Inject, Injectable } from "@nestjs/common";
import { and, eq, exists, ilike, or, sql } from "drizzle-orm";
import { leads, deals, contacts, clients, projects, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { applyScope } from "../access/apply-scope";
import { authorize, type AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";

export type SearchResultType = "lead" | "deal" | "contact" | "client" | "ticket";

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
    const contactScope =
      contactAccess === "all"
        ? sql`true`
        : contactAccess
          ? or(
              exists(
                this.db
                  .select({ value: sql`1` })
                  .from(leads)
                  .where(
                    and(
                      eq(leads.orgId, orgId),
                      eq(leads.id, contacts.leadId),
                      applyScope(contactAccess, orgId, userId, {
                        ownerColumn: leads.assignedToId,
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
                      eq(deals.orgId, orgId),
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
        .select({ id: leads.id, name: leads.name, email: leads.email, company: leads.company, status: leads.status })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            applyScope(access.leads, orgId, userId, {
              ownerColumn: leads.assignedToId,
            }),
            or(
              ilike(leads.name, pattern),
              ilike(leads.email, pattern),
              ilike(leads.company, pattern),
              ilike(leads.phone, pattern),
            ),
          ),
        )
        .limit(maxPer)
        : Promise.resolve([]),

      access.deals
        ? this.db
        .select({ id: deals.id, name: deals.name, value: deals.value, stage: deals.stage, contactPerson: deals.contactPerson })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
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
        .select({ id: contacts.id, name: contacts.name, email: contacts.email, company: contacts.company })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            contactScope,
            or(ilike(contacts.name, pattern), ilike(contacts.email, pattern), ilike(contacts.company, pattern)),
          ),
        )
        .limit(maxPer)
        : Promise.resolve([]),

      access.clients
        ? this.db
        .select({ id: clients.id, name: clients.name, company: clients.company, status: clients.status })
        .from(clients)
        .where(
          and(
            eq(clients.orgId, orgId),
            applyScope(access.clients, orgId, userId, {
              ownerColumn: clients.accountManagerId,
            }),
            or(ilike(clients.name, pattern), ilike(clients.company, pattern)),
          ),
        )
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
