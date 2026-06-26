import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ilike, or } from "drizzle-orm";
import { leads, deals, contacts, clients, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

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

@Injectable()
export class SearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  search(orgId: string, userId: string, q: string, limit: number | undefined): Promise<SearchResponse> {
    const queryHash = Buffer.from(q + (limit ?? "")).toString("base64url").slice(0, 32);
    return this.cache.cached(
      CACHE_KEYS.searchResults(orgId, userId, queryHash),
      () => this.executeSearch(orgId, q, limit),
      CACHE_TTL.SHORT,
    );
  }

  private async executeSearch(orgId: string, q: string, limit: number | undefined): Promise<SearchResponse> {
    const maxPer = Math.min(limit ?? 5, 10);
    const pattern = `%${q}%`;

    const [leadResults, dealResults, contactResults, clientResults, ticketResults] = await Promise.all([
      this.db
        .select({ id: leads.id, name: leads.name, email: leads.email, company: leads.company, status: leads.status })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            or(
              ilike(leads.name, pattern),
              ilike(leads.email, pattern),
              ilike(leads.company, pattern),
              ilike(leads.phone, pattern),
            ),
          ),
        )
        .limit(maxPer),

      this.db
        .select({ id: deals.id, name: deals.name, value: deals.value, stage: deals.stage, contactPerson: deals.contactPerson })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            or(ilike(deals.name, pattern), ilike(deals.contactPerson, pattern)),
          ),
        )
        .limit(maxPer),

      this.db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email, company: contacts.company })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            or(ilike(contacts.name, pattern), ilike(contacts.email, pattern), ilike(contacts.company, pattern)),
          ),
        )
        .limit(maxPer),

      this.db
        .select({ id: clients.id, name: clients.name, company: clients.company, status: clients.status })
        .from(clients)
        .where(
          and(
            eq(clients.orgId, orgId),
            or(ilike(clients.name, pattern), ilike(clients.company, pattern)),
          ),
        )
        .limit(maxPer),

      this.db
        .select({ id: tickets.id, title: tickets.title, status: tickets.status, projectId: tickets.projectId })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), ilike(tickets.title, pattern)))
        .limit(maxPer),
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
        subtitle: `Ticket #${t.id}`,
        href: `/projects`,
        status: t.status,
      })),
    ];

    return { results, total: results.length };
  }
}
