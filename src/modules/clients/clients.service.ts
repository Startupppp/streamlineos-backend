import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, or, type SQL } from "drizzle-orm";
import { users } from "../../db/schema";
import { businessParties, clientPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { DataScope } from "../access/access.types";
import { toCsv } from "../inventory/import-export/csv.util";
import {
  CLIENT_PARTY_COLUMNS,
  CLIENT_PARTY_JOIN,
  clientPartyScope,
  clientPartyViewScope,
} from "./client-party-reader";

export type ClientHealthFilter = "healthy" | "at_risk" | "critical";

@Injectable()
export class ClientsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listClients(orgId: string, userId: string, scope: DataScope): Promise<{ id: number; name: string | null }[]> {
    return this.db
      .select({ id: CLIENT_PARTY_COLUMNS.id, name: CLIENT_PARTY_COLUMNS.name })
      .from(clientPartyMap)
      .innerJoin(businessParties, CLIENT_PARTY_JOIN)
      .where(and(...clientPartyScope(orgId), clientPartyViewScope(orgId, userId, scope)))
      // Names repeat, and a hundred of them is a truncation -- the id decides
      // which hundred rather than the heap order the map join changes.
      .orderBy(asc(CLIENT_PARTY_COLUMNS.name), asc(CLIENT_PARTY_COLUMNS.id))
      .limit(100);
  }

  getHealth(orgId: string, status: ClientHealthFilter | undefined, limit: number | undefined, userId: string, scope: DataScope) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "clients:health",
      `${userId}:${scope}:${status ?? "all"}:${limit ?? 20}`,
      async () => {
        /*
         * `health_status` is NOT NULL on the legacy row and nullable on the
         * party -- a party that has never been a customer has no health -- so the
         * filter compares the coalesced expression the mirror derives. Comparing
         * the raw column would drop every client whose health has not been
         * scored yet, which is exactly the set an "at risk" filter must not
         * silently exclude.
         */
        const conditions: SQL[] = [
          ...clientPartyScope(orgId),
          clientPartyViewScope(orgId, userId, scope),
        ];
        if (status) conditions.push(eq(CLIENT_PARTY_COLUMNS.healthStatus, status));

        const results = await this.db
          .select({
            id: CLIENT_PARTY_COLUMNS.id,
            name: CLIENT_PARTY_COLUMNS.name,
            company: CLIENT_PARTY_COLUMNS.company,
            healthScore: CLIENT_PARTY_COLUMNS.healthScore,
            healthStatus: CLIENT_PARTY_COLUMNS.healthStatus,
            churnRiskScore: CLIENT_PARTY_COLUMNS.churnRiskScore,
            churnRiskReasoning: CLIENT_PARTY_COLUMNS.churnRiskReasoning,
            lastHealthCheck: CLIENT_PARTY_COLUMNS.lastHealthCheck,
            investmentValue: CLIENT_PARTY_COLUMNS.investmentValue,
            status: CLIENT_PARTY_COLUMNS.status,
          })
          .from(clientPartyMap)
          .innerJoin(businessParties, CLIENT_PARTY_JOIN)
          .where(and(...conditions))
          .orderBy(asc(CLIENT_PARTY_COLUMNS.healthScore), asc(CLIENT_PARTY_COLUMNS.id))
          .limit(limit ?? 20);

        const summary = { healthy: 0, at_risk: 0, critical: 0 };
        for (const c of results) {
          const hs = c.healthStatus as keyof typeof summary;
          if (hs in summary) summary[hs]++;
        }
        return { items: results, summary };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getChurnAlerts(orgId: string, userId: string, scope: DataScope) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "clients:churn",
      `${userId}:${scope}`,
      async () => {
        const atRiskClients = await this.db
          .select({
            id: CLIENT_PARTY_COLUMNS.id,
            name: CLIENT_PARTY_COLUMNS.name,
            company: CLIENT_PARTY_COLUMNS.company,
            healthScore: CLIENT_PARTY_COLUMNS.healthScore,
            healthStatus: CLIENT_PARTY_COLUMNS.healthStatus,
            churnRiskScore: CLIENT_PARTY_COLUMNS.churnRiskScore,
            churnRiskReasoning: CLIENT_PARTY_COLUMNS.churnRiskReasoning,
            lastHealthCheck: CLIENT_PARTY_COLUMNS.lastHealthCheck,
            investmentValue: CLIENT_PARTY_COLUMNS.investmentValue,
            accountManagerId: CLIENT_PARTY_COLUMNS.accountManagerId,
            accountManagerName: users.name,
          })
          .from(clientPartyMap)
          .innerJoin(businessParties, CLIENT_PARTY_JOIN)
          .leftJoin(users, eq(CLIENT_PARTY_COLUMNS.accountManagerId, users.id))
          .where(
            and(
              ...clientPartyScope(orgId),
              clientPartyViewScope(orgId, userId, scope),
              or(
                eq(CLIENT_PARTY_COLUMNS.healthStatus, "at_risk"),
                eq(CLIENT_PARTY_COLUMNS.healthStatus, "critical"),
              ),
            ),
          )
          // `churn_risk_score` is nullable and ties freely; the id says which
          // twenty alerts an org sees.
          .orderBy(desc(CLIENT_PARTY_COLUMNS.churnRiskScore), desc(CLIENT_PARTY_COLUMNS.id))
          .limit(20);

        const critical = atRiskClients.filter((c) => c.healthStatus === "critical").length;
        const atRisk = atRiskClients.filter((c) => c.healthStatus === "at_risk").length;
        return { alerts: atRiskClients, summary: { critical, atRisk, total: atRiskClients.length } };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async exportCsv(orgId: string, userId: string, scope: DataScope): Promise<string> {
    const rows = await this.db
      .select({
        id: CLIENT_PARTY_COLUMNS.id,
        name: CLIENT_PARTY_COLUMNS.name,
        email: CLIENT_PARTY_COLUMNS.email,
        phone: CLIENT_PARTY_COLUMNS.phone,
        company: CLIENT_PARTY_COLUMNS.company,
        city: CLIENT_PARTY_COLUMNS.city,
        status: CLIENT_PARTY_COLUMNS.status,
        healthScore: CLIENT_PARTY_COLUMNS.healthScore,
        healthStatus: CLIENT_PARTY_COLUMNS.healthStatus,
        investmentValue: CLIENT_PARTY_COLUMNS.investmentValue,
        createdAt: CLIENT_PARTY_COLUMNS.createdAt,
      })
      .from(clientPartyMap)
      .innerJoin(businessParties, CLIENT_PARTY_JOIN)
      .where(and(...clientPartyScope(orgId), clientPartyViewScope(orgId, userId, scope)))
      .orderBy(asc(CLIENT_PARTY_COLUMNS.name), asc(CLIENT_PARTY_COLUMNS.id));

    const headers = [
      "id",
      "name",
      "email",
      "phone",
      "company",
      "city",
      "status",
      "healthScore",
      "healthStatus",
      "investmentValue",
      "createdAt",
    ];
    return toCsv(
      headers,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email ?? "",
        phone: r.phone ?? "",
        company: r.company ?? "",
        city: r.city ?? "",
        status: r.status,
        healthScore: r.healthScore ?? "",
        healthStatus: r.healthStatus ?? "",
        investmentValue: r.investmentValue ?? "",
        createdAt: r.createdAt?.toISOString() ?? "",
      })),
    );
  }
}
