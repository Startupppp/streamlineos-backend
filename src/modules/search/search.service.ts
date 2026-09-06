import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { deals, projects, tickets } from "../../db/schema";
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
import { type AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { logger } from "../../common/logger/logger.service";
import { actingMembershipId } from "../../common/auth/principal";
import { moduleAvailability, type ModuleAvailabilityResolver } from "../../common/rbac/module-availability";

const UNDEFINED_FUNCTION = "42883";

function isUndefinedFunction(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const { code } = err;
  return code === UNDEFINED_FUNCTION;
}

export type SearchResultType = "lead" | "deal" | "contact" | "client" | "ticket";

const leadOwnerParty = alias(businessParties, "search_lead_owner_party");

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
  let moduleMapPromise: Promise<Record<string, boolean>> | undefined;
  const memoGetModuleMap = (orgId: string): Promise<Record<string, boolean>> => {
    if (!moduleMapPromise) {
      moduleMapPromise = (async () => {
        const crmState = await access.getModuleState(orgId, "crm");
        const buildState = await access.getModuleState(orgId, "build");
        return { crm: crmState ?? false, build: buildState ?? false };
      })();
    }
    return moduleMapPromise;
  };

  const baseResolver = access.buildModuleAvailabilityResolver(memoGetModuleMap);

  let deniedModulesPromise: Promise<Set<string>> | undefined;
  let planLockedPromise: Promise<readonly string[]> | undefined;
  const resolver: ModuleAvailabilityResolver = {
    isCoreModule: (key) => baseResolver.isCoreModule(key),
    getModuleMap: (orgId) => baseResolver.getModuleMap(orgId),
    getUserDeniedModules: (orgId, userId) => {
      if (!deniedModulesPromise)
        deniedModulesPromise = baseResolver.getUserDeniedModules(orgId, userId);
      return deniedModulesPromise;
    },
    getPlanLockedModules: (orgId) => {
      if (!planLockedPromise)
        planLockedPromise = baseResolver.getPlanLockedModules(orgId);
      return planLockedPromise;
    },
  };
  const [[crmAvail, buildAvail], [leadScope, dealScope, contactScope, clientScope, buildScope]] =
    await Promise.all([
      Promise.all([
        moduleAvailability(resolver, user.orgId, user.userId, "crm"),
        moduleAvailability(resolver, user.orgId, user.userId, "build"),
      ]),
      Promise.all([
        access.scopeFor(user, "crm:leads:view"),
        access.scopeFor(user, "crm:deals:read"),
        access.scopeFor(user, "crm:contacts:view"),
        access.scopeFor(user, "crm:clients:read"),
        access.scopeFor(user, "build:tickets:view"),
      ]),
    ]);

  return {
    leads: crmAvail.available && leadScope !== "none" ? leadScope : null,
    deals: crmAvail.available && dealScope !== "none" ? dealScope : null,
    contacts: crmAvail.available && contactScope !== "none" ? contactScope : null,
    clients: crmAvail.available && clientScope !== "none" ? clientScope : null,
    build: buildAvail.available && buildScope !== "none" ? buildScope : null,
  };
}

// Kinds that have a SECURITY DEFINER id-probe SDF.
type SdfKind = "lead" | "deal" | "contact" | "client" | "ticket";

/**
 * Outcome of a per-kind SDF probe after the combined UNION ALL.
 *
 *   ids === null           — ILIKE fallback (over cap or combined probe failed)
 *   ids.length === 0       — no matches; caller must skip the hydration query
 *   ids.length > 0         — caller uses an inArray condition
 */
type KindProbe = { ids: readonly string[] } | { ids: null };

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

  private async probeAllIds(
    access: SearchAccess,
    q: string,
    needsTicketProbe: boolean,
  ): Promise<ReadonlyMap<SdfKind, KindProbe>> {
    type Part = { kind: SdfKind; stmt: SQL<unknown>; cap: number };
    const parts: Part[] = [];

    if (access.leads !== null)
      parts.push({ kind: "lead", stmt: sql`SELECT 'lead' AS kind, id FROM app.search_lead_party_ids(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`, cap: PARTY_SEARCH_CAP });
    if (access.deals !== null)
      parts.push({ kind: "deal", stmt: sql`SELECT 'deal' AS kind, id::text FROM app.search_deal_ids(${q}, ${DEAL_SEARCH_CAP + 1}) AS id`, cap: DEAL_SEARCH_CAP });
    if (access.contacts !== null)
      parts.push({ kind: "contact", stmt: sql`SELECT 'contact' AS kind, id FROM app.search_contact_party_ids(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`, cap: PARTY_SEARCH_CAP });
    if (access.clients !== null)
      parts.push({ kind: "client", stmt: sql`SELECT 'client' AS kind, id FROM app.search_client_party_ids(${q}, ${PARTY_SEARCH_CAP + 1}) AS id`, cap: PARTY_SEARCH_CAP });
    if (needsTicketProbe && access.build !== null)
      parts.push({ kind: "ticket", stmt: sql`SELECT 'ticket' AS kind, id::text FROM app.search_ticket_ids(${q}, ${TICKET_ID_CAP + 1}) AS id`, cap: TICKET_ID_CAP });

    const result = new Map<SdfKind, KindProbe>();
    if (parts.length === 0) return result;

    const unionStmt = sql.join(parts.map((p) => p.stmt), sql` UNION ALL `);
    let rawRows: Record<string, unknown>[];
    try {
      rawRows = await this.db.execute<Record<string, unknown>>(unionStmt);
    } catch (err: unknown) {
      if (!isUndefinedFunction(err)) throw err;
      logger.error(
        "search_*_ids combined probe returned 42883; all active kinds fall back to ILIKE",
        { cause: err instanceof Error ? err.message : String(err) },
      );
      for (const { kind } of parts) result.set(kind, { ids: null });
      return result;
    }

    const byKind = new Map<string, string[]>();
    for (const row of rawRows) {
      const kind = String(row["kind"] ?? "");
      const id = String(row["id"] ?? "");
      const bucket = byKind.get(kind);
      if (bucket) bucket.push(id);
      else byKind.set(kind, [id]);
    }

    for (const { kind, cap } of parts) {
      const ids = byKind.get(kind) ?? [];
      result.set(kind, ids.length > cap ? { ids: null } : { ids });
    }
    return result;
  }

  private toPartyCond(probe: KindProbe | undefined, fallback: SQL<unknown>): SQL<unknown> | null {
    if (probe === undefined || probe.ids === null) return fallback;
    if (probe.ids.length === 0) return null;
    return inArray(businessParties.partyId, [...probe.ids]);
  }

  private toDealCond(probe: KindProbe | undefined, pattern: string): SQL<unknown> | null {
    if (probe === undefined || probe.ids === null)
      return or(ilike(deals.name, pattern), ilike(deals.contactPerson, pattern)) ?? sql`false`;
    if (probe.ids.length === 0) return null;
    return inArray(deals.id, probe.ids.map(Number));
  }

  private toTicketCond(probe: KindProbe | undefined, pattern: string): SQL<unknown> | null {
    if (probe === undefined || probe.ids === null) return ilike(tickets.title, pattern);
    if (probe.ids.length === 0) return null;
    return inArray(tickets.id, probe.ids.map(Number));
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
                  .from(leadOwnerParty)
                  .where(
                    and(
                      eq(leadOwnerParty.organizationId, orgId),
                      eq(leadOwnerParty.partyId, businessParties.convertedFromPartyId),
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
                      eq(deals.id, businessParties.primaryDealId),
                      applyScope(contactAccess, orgId, userId, {
                        ownerColumn: deals.assignedToId,
                      }),
                    ),
                  ),
              ),
            )
          : sql`false`;

    const probes = await this.probeAllIds(access, q, needsTicketProbe);

    const leadFallback = or(ilike(businessParties.name, pattern), ilike(businessParties.email, pattern), ilike(businessParties.phone, pattern), ilike(businessParties.companyName, pattern)) ?? sql`false`;
    const contactFallback = or(ilike(businessParties.name, pattern), ilike(businessParties.email, pattern), ilike(businessParties.companyName, pattern)) ?? sql`false`;
    const clientFallback = or(ilike(businessParties.name, pattern), ilike(businessParties.companyName, pattern)) ?? sql`false`;

    const leadCond = this.toPartyCond(probes.get("lead"), leadFallback);
    const dealCond = this.toDealCond(probes.get("deal"), pattern);
    const contactCond = this.toPartyCond(probes.get("contact"), contactFallback);
    const clientCond = this.toPartyCond(probes.get("client"), clientFallback);
    const ticketTitleCond = this.toTicketCond(probes.get("ticket"), pattern);

    const ticketKey = keyMatch?.[1];
    const ticketNumStr = keyMatch?.[2];
    const ticketWhere: SQL<unknown> | null =
      ticketKey !== undefined && ticketNumStr !== undefined
        ? and(ilike(projects.key, ticketKey), eq(tickets.ticketNumber, Number(ticketNumStr))) ?? sql`false`
        : numericTicket !== null
          ? eq(tickets.ticketNumber, numericTicket)
          : ticketTitleCond;

    const [leadResults, dealResults, contactResults, clientResults, ticketResults] = await Promise.all([
      access.leads !== null && leadCond !== null
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
            leadCond,
          ),
        )
        .orderBy(desc(businessParties.updatedAt), desc(leadPartyMap.leadId))
        .limit(maxPer)
        : Promise.resolve([]),

      access.deals !== null && dealCond !== null
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

      access.contacts !== null && contactCond !== null
        ? this.db
        .select({
          id: contactPartyMap.contactId,
          name: businessParties.name,
          email: businessParties.email,
          company: businessParties.companyName,
        })
        .from(contactPartyMap)
        .innerJoin(businessParties, PARTY_OF_CONTACT)
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

      access.clients !== null && clientCond !== null
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

      access.build !== null && ticketWhere !== null
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
            access.build === "all"
              ? sql`true`
              : (() => {
                  const membershipId = actingMembershipId(user.principal);
                  return membershipId === null
                    ? sql`false`
                    : eq(tickets.assigneeMembershipId, membershipId);
                })(),
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
