import { Inject, Injectable } from "@nestjs/common";
import { eq, and, or, asc, desc } from "drizzle-orm";
import { clients, deals, dealActivities, leadActivities, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

export type ClientHealthFilter = "healthy" | "at_risk" | "critical";

export interface TimelineEvent {
  id: string;
  type: "deal_created" | "deal_stage_change" | "call" | "email" | "meeting" | "note" | "conversion";
  title: string;
  description: string;
  date: string;
  user?: string;
}

@Injectable()
export class ClientsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listClients(orgId: string) {
    return this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.orgId, orgId))
      .orderBy(clients.name);
  }

  getHealth(orgId: string, status: ClientHealthFilter | undefined, limit: number | undefined) {
    return this.cache.cached(
      CACHE_KEYS.clientsHealth(orgId),
      async () => {
        const conditions = [eq(clients.orgId, orgId)];
        if (status) conditions.push(eq(clients.healthStatus, status));

        const results = await this.db
          .select({
            id: clients.id,
            name: clients.name,
            company: clients.company,
            healthScore: clients.healthScore,
            healthStatus: clients.healthStatus,
            churnRiskScore: clients.churnRiskScore,
            churnRiskReasoning: clients.churnRiskReasoning,
            lastHealthCheck: clients.lastHealthCheck,
            investmentValue: clients.investmentValue,
            status: clients.status,
          })
          .from(clients)
          .where(and(...conditions))
          .orderBy(asc(clients.healthScore))
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

  getChurnAlerts(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.churnAlerts(orgId),
      async () => {
        const atRiskClients = await this.db
          .select({
            id: clients.id,
            name: clients.name,
            company: clients.company,
            healthScore: clients.healthScore,
            healthStatus: clients.healthStatus,
            churnRiskScore: clients.churnRiskScore,
            churnRiskReasoning: clients.churnRiskReasoning,
            lastHealthCheck: clients.lastHealthCheck,
            investmentValue: clients.investmentValue,
            accountManagerId: clients.accountManagerId,
            accountManagerName: users.name,
          })
          .from(clients)
          .leftJoin(users, eq(clients.accountManagerId, users.id))
          .where(
            and(
              eq(clients.orgId, orgId),
              or(eq(clients.healthStatus, "at_risk"), eq(clients.healthStatus, "critical")),
            ),
          )
          .orderBy(desc(clients.churnRiskScore))
          .limit(20);

        const critical = atRiskClients.filter((c) => c.healthStatus === "critical").length;
        const atRisk = atRiskClients.filter((c) => c.healthStatus === "at_risk").length;
        return { alerts: atRiskClients, summary: { critical, atRisk, total: atRiskClients.length } };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getTimeline(orgId: string, clientId: number): Promise<{ events: TimelineEvent[]; total: number } | null> {
    const [client] = await this.db
      .select({ id: clients.id, name: clients.name, convertedAt: clients.convertedAt, leadId: clients.leadId })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)));
    if (!client) return null;

    const events: TimelineEvent[] = [];

    if (client.convertedAt) {
      events.push({
        id: `conversion-${clientId}`,
        type: "conversion",
        title: "Client converted",
        description: `${client.name} was converted from lead to client`,
        date: new Date(client.convertedAt).toISOString(),
      });
    }

    const clientDeals = await this.db
      .select({ id: deals.id, name: deals.name, createdAt: deals.createdAt })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), eq(deals.clientId, clientId)));

    for (const deal of clientDeals) {
      events.push({
        id: `deal-${deal.id}`,
        type: "deal_created",
        title: `Deal created: ${deal.name}`,
        description: `New deal associated with this client`,
        date: deal.createdAt ? new Date(deal.createdAt).toISOString() : new Date().toISOString(),
      });

      const activities = await this.db
        .select({
          id: dealActivities.id,
          type: dealActivities.type,
          subject: dealActivities.subject,
          notes: dealActivities.notes,
          createdAt: dealActivities.createdAt,
          userName: users.name,
        })
        .from(dealActivities)
        .leftJoin(users, eq(dealActivities.userId, users.id))
        .where(eq(dealActivities.dealId, deal.id))
        .orderBy(desc(dealActivities.createdAt))
        .limit(10);

      for (const act of activities) {
        events.push({
          id: `deal-act-${act.id}`,
          type: act.type as TimelineEvent["type"],
          title: act.subject || `${act.type} logged`,
          description: act.notes || "",
          date: act.createdAt ? new Date(act.createdAt).toISOString() : new Date().toISOString(),
          user: act.userName ?? undefined,
        });
      }
    }

    if (client.leadId) {
      const leadActs = await this.db
        .select({
          id: leadActivities.id,
          type: leadActivities.type,
          subject: leadActivities.subject,
          notes: leadActivities.notes,
          date: leadActivities.date,
          userName: users.name,
        })
        .from(leadActivities)
        .leftJoin(users, eq(leadActivities.userId, users.id))
        .where(eq(leadActivities.leadId, client.leadId))
        .orderBy(desc(leadActivities.date))
        .limit(10);

      for (const act of leadActs) {
        events.push({
          id: `lead-act-${act.id}`,
          type: act.type as TimelineEvent["type"],
          title: act.subject || `${act.type} (pre-conversion)`,
          description: act.notes || "",
          date: new Date(act.date).toISOString(),
          user: act.userName ?? undefined,
        });
      }
    }

    events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return { events, total: events.length };
  }
}
