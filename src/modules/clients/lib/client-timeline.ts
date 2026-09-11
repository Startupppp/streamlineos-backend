import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { deals, dealActivities, leadActivities, users } from "../../../db/schema";
import { businessParties, clientPartyMap, leadPartyMap } from "../../../db/schema/party";
import { type Db } from "../../../db/drizzle.module";
import {
  CLIENT_PARTY_COLUMNS,
  CLIENT_PARTY_JOIN,
  clientIdIs,
  clientPartyScope,
} from "../client-party-reader";

/**
 * One client's activity timeline, assembled from four sources.
 *
 * Split out of `clients.service.ts` because it is the only read there that is
 * not about a client's CURRENT state — the list, the health score and the churn
 * alerts all answer "how is this account now", and this answers "what has
 * happened to it", which is why it is the one that has to reach back through
 * `converted_from_party_id` into the lead the client came from.
 *
 * A plain `db` parameter rather than a deps bag: it needs nothing else.
 */

export interface TimelineEvent {
  id: string;
  type: "deal_created" | "deal_stage_change" | "call" | "email" | "meeting" | "note" | "conversion";
  title: string;
  description: string;
  date: string;
  user?: string;
}

export async function getClientTimeline(
  db: Db,
  orgId: string,
  clientId: number,
): Promise<{ events: TimelineEvent[]; total: number } | null> {
  /*
   * The lead this client converted from, which 0265 moved onto the party as
   * `converted_from_party_id`. `lead_activities` is keyed by the integer lead
   * id, so the map is joined back to recover it -- an id, never a name, and a
   * LEFT join because most clients were never a lead and the timeline still has
   * deals to show for them. The legacy row is not read at all any more.
   */
  const [client] = await db
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
    .where(and(...clientPartyScope(orgId), clientIdIs(clientId)));
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

  const clientDeals = await db
    .select({ id: deals.id, name: deals.name, createdAt: deals.createdAt })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.clientId, clientId)));

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
    ? await db
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
      type: act.type as TimelineEvent["type"],
      title: act.subject || `${act.type} logged`,
      description: act.notes || "",
      date: act.createdAt ? new Date(act.createdAt).toISOString() : new Date().toISOString(),
      user: act.userName ?? undefined,
    });
  }

  if (client.leadId) {
    const leadActs = await db
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
