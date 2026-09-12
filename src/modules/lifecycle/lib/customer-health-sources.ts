import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { activities } from "../../../db/schema/crm/activities";
import { supportTickets } from "../../../db/schema/support/tickets";
import { supportAiSuggestions } from "../../../db/schema/support/support-ai";
import { customerLifecycleSignals } from "../../../db/schema/crm/lifecycle";
import type { SourceAvailability } from "../customer-health.types";

/**
 * Whether each source is in use by this organisation AT ALL.
 *
 * This is the question that decides whether an empty result is a measurement
 * or a gap, and it has to be asked organisation-wide rather than per customer:
 * "this customer has no activity" means silence in a tenant that logs
 * activities and means nothing whatsoever in a tenant that does not. Getting
 * this backwards would drop every customer of every tenant that has not
 * adopted the timeline straight into the critical band.
 *
 * Each probe requires the anchor as well as the row — an activity with no
 * `party_id`, or a ticket with no `client_party_id`, can never be counted
 * against a customer, so a tenant with a million of them still has no usable
 * source and must be told so.
 */
export async function sourcesInUse(db: Db, organizationId: string): Promise<SourceAvailability> {
  const [engagement, support, sentiment, usage] = await Promise.all([
    db
      .select({ present: sql<number>`1` })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          isNotNull(activities.partyId),
          isNull(activities.deletedAt),
        ),
      )
      .limit(1),
    db
      .select({ present: sql<number>`1` })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, organizationId),
          isNotNull(supportTickets.clientPartyId),
        ),
      )
      .limit(1),
    db
      .select({ present: sql<number>`1` })
      .from(supportAiSuggestions)
      .innerJoin(
        supportTickets,
        and(
          eq(supportTickets.id, supportAiSuggestions.ticketId),
          eq(supportTickets.orgId, supportAiSuggestions.orgId),
        ),
      )
      .where(
        and(
          eq(supportAiSuggestions.orgId, organizationId),
          eq(supportAiSuggestions.type, "sentiment"),
          isNotNull(supportTickets.clientPartyId),
        ),
      )
      .limit(1),
    db
      .select({ present: sql<number>`1` })
      .from(customerLifecycleSignals)
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, organizationId),
          eq(customerLifecycleSignals.kind, "usage-decline"),
        ),
      )
      .limit(1),
  ]);

  return {
    engagement: engagement.length > 0,
    support: support.length > 0,
    sentiment: sentiment.length > 0,
    usage: usage.length > 0,
  };
}
