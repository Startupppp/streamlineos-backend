import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { deals, dealActivities, leadActivities, users } from "../../db/schema";
import { businessParties, clientPartyMap, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  CLIENT_PARTY_COLUMNS,
  CLIENT_PARTY_JOIN,
  clientIdIs,
  clientPartyScope,
} from "./client-party-reader";

const timelineEventTypeSchema = z.enum([
  "deal_created", "deal_stage_change", "call", "email", "meeting", "note", "conversion",
]);

export interface TimelineEvent {
  id: string;
  type: z.infer<typeof timelineEventTypeSchema>;
  title: string;
  description: string;
  date: string;
  user?: string;
}

/**
 * The client activity timeline: a read that unions the party's conversion stamp,
 * its deals, those deals' activities and — when the client converted from a lead
 * — the pre-conversion lead activities, into one date-ordered list.
 *
 * It is its own service rather than a method on `ClientsService` because it is
 * the only client read that reaches outside the party/client tables into `deals`,
 * `deal_activities`, `lead_activities` and `users`; that join set changes with
 * the activity model, not with the client record.
 */
@Injectable()
export class ClientTimelineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getTimeline(orgId: string, clientId: number): Promise<{ events: TimelineEvent[]; total: number } | null> {
    /*
     * The lead this client converted from, which 0265 moved onto the party as
     * `converted_from_party_id`. `lead_activities` is keyed by the integer lead
     * id, so the map is joined back to recover it -- an id, never a name, and a
     * LEFT join because most clients were never a lead and the timeline still has
     * deals to show for them. The legacy row is not read at all any more.
     */
    const [client] = await this.db
      .select({
        id: CLIENT_PARTY_COLUMNS.id,
        name: CLIENT_PARTY_COLUMNS.name,
        convertedAt: CLIENT_PARTY_COLUMNS.convertedAt,
        leadId: leadPartyMap.leadId,
      })
      .from(clientPartyMap)
      .innerJoin(businessParties, CLIENT_PARTY_JOIN)
      // The tenant named as a literal rather than correlated, so a party id
      // shared across organisations cannot reach the wrong map row and the
      // planner can push the constant into the index.
      .leftJoin(
        leadPartyMap,
        and(
          eq(leadPartyMap.partyId, businessParties.convertedFromPartyId),
          eq(leadPartyMap.organizationId, orgId),
        ),
      )
      .where(and(...clientPartyScope(orgId), clientIdIs(clientId)))
      .limit(1);
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
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.clientId, clientId)))
      .orderBy(desc(deals.id))
      .limit(200);

    for (const deal of clientDeals) {
      events.push({
        id: `deal-${deal.id}`,
        type: "deal_created",
        title: `Deal created: ${deal.name}`,
        description: `New deal associated with this client`,
        date: deal.createdAt ? new Date(deal.createdAt).toISOString() : new Date().toISOString(),
      });
    }

    const dealIds = clientDeals.map((d) => d.id);
    const allDealActivities = dealIds.length > 0
      ? await this.db
          .select({
            id: dealActivities.id,
            dealId: dealActivities.dealId,
            type: dealActivities.type,
            subject: dealActivities.subject,
            notes: dealActivities.notes,
            createdAt: dealActivities.createdAt,
            userName: users.name,
          })
          .from(dealActivities)
          .leftJoin(users, eq(dealActivities.userId, users.id))
          .where(inArray(dealActivities.dealId, dealIds))
          .orderBy(desc(dealActivities.createdAt))
          .limit(50)
      : [];

    for (const act of allDealActivities) {
      events.push({
        id: `deal-act-${act.id}`,
        type: timelineEventTypeSchema.parse(act.type),
        title: act.subject || `${act.type} logged`,
        description: act.notes || "",
        date: act.createdAt ? new Date(act.createdAt).toISOString() : new Date().toISOString(),
        user: act.userName ?? undefined,
      });
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
          type: timelineEventTypeSchema.parse(act.type),
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
