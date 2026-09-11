import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { activities } from "../../../db/schema/crm/activities";
import { supportTickets } from "../../../db/schema/support/tickets";
import { supportAiSuggestions } from "../../../db/schema/support/support-ai";
import { customerLifecycleSignals, customerLifecycles } from "../../../db/schema/crm/lifecycle";
import {
  engagementFactor,
  healthWindow,
  sentimentFactor,
  supportFactor,
  usageFactor,
} from "../health-factors";
import type { HealthFactor } from "../health-score";

/*
  The four per-customer source reads a health assessment is made of, moved out
  of `CustomerHealthService` with the handle passed in. Each counts rows and
  hands the counts to the pure factor in `health-factors.ts`; none of them
  decides what a count means.
*/

/**
 * Engagement, from the unified timeline.
 *
 * One query over the party's whole timeline rather than two: the window counts
 * come back as FILTERed aggregates and the last-contact date as an unfiltered
 * `max`, because the recency term has to see contact that predates the window
 * — a customer last spoken to on day 91 and one never spoken to at all are not
 * the same customer, and two separate windowed queries could not tell them
 * apart.
 */
export async function readEngagement(
  db: Db,
  organizationId: string,
  partyId: string,
  window: ReturnType<typeof healthWindow>,
  sourceInUse: boolean,
): Promise<HealthFactor> {
  const [row] = await db
    .select({
      activityCount: sql<number>`count(*) FILTER (WHERE ${activities.occurredAt} >= ${window.from})::int`,
      /**
       * Distinct days, not rows. An ingested mail thread writes dozens of rows
       * in one second and counting them would score an import as a quarter of
       * daily contact.
       */
      contactDays: sql<number>`count(DISTINCT date(${activities.occurredAt})) FILTER (WHERE ${activities.occurredAt} >= ${window.from})::int`,
      lastActivityAt: sql<Date | null>`max(${activities.occurredAt})`,
    })
    .from(activities)
    .where(
      and(
        eq(activities.organizationId, organizationId),
        eq(activities.partyId, partyId),
        isNull(activities.deletedAt),
      ),
    );

  return engagementFactor(
    {
      sourceInUse,
      activityCount: row?.activityCount ?? 0,
      contactDays: row?.contactDays ?? 0,
      lastActivityAt: coerceDate(row?.lastActivityAt ?? null),
    },
    window,
  );
}

/**
 * Support history, from the helpdesk.
 *
 * `client_party_id` rather than `client_id`: the legacy column is an id into a
 * table the party model replaced, and reading it would double-count any
 * customer whose two legacy records were merged into one Party while missing
 * every ticket raised since the backfill.
 *
 * A breach is counted against the SLA deadline in both directions — resolved
 * late, or still open past it — because a ticket that has been open for three
 * weeks past its commitment is the worst case and would otherwise be the only
 * one this misses.
 */
export async function readSupport(
  db: Db,
  organizationId: string,
  partyId: string,
  window: ReturnType<typeof healthWindow>,
  sourceInUse: boolean,
): Promise<HealthFactor> {
  const [row] = await db
    .select({
      opened: sql<number>`count(*) FILTER (WHERE ${supportTickets.createdAt} >= ${window.from})::int`,
      urgent: sql<number>`count(*) FILTER (WHERE ${supportTickets.createdAt} >= ${window.from} AND ${supportTickets.priority} IN ('HIGH', 'URGENT'))::int`,
      slaBreached: sql<number>`count(*) FILTER (
        WHERE ${supportTickets.createdAt} >= ${window.from}
          AND ${supportTickets.slaDeadline} IS NOT NULL
          AND (
            (${supportTickets.resolvedAt} IS NOT NULL AND ${supportTickets.resolvedAt} > ${supportTickets.slaDeadline})
            OR (${supportTickets.resolvedAt} IS NULL AND ${supportTickets.slaDeadline} < ${window.to})
          )
      )::int`,
      openNow: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} NOT IN ('RESOLVED', 'CLOSED'))::int`,
    })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.orgId, organizationId),
        eq(supportTickets.clientPartyId, partyId),
      ),
    );

  return supportFactor(
    {
      sourceInUse,
      opened: row?.opened ?? 0,
      urgent: row?.urgent ?? 0,
      slaBreached: row?.slaBreached ?? 0,
      openNow: row?.openNow ?? 0,
    },
    window,
  );
}

/**
 * Conversation sentiment, from the support triage the AI already runs.
 *
 * `status <> 'rejected'` is load-bearing: a rejected suggestion is one a human
 * looked at and said was wrong, and counting it would mean the model's own
 * mistakes keep scoring a customer after somebody corrected them.
 *
 * `observedEver` is carried separately from the windowed counts so the factor
 * can tell "never analysed" from "analysed, all of it older than the window".
 * Those are different gaps: one is fixed by asking the customer something, the
 * other by noticing that nobody has in six months.
 */
export async function readSentiment(
  db: Db,
  organizationId: string,
  partyId: string,
  window: ReturnType<typeof healthWindow>,
  sourceInUse: boolean,
): Promise<HealthFactor> {
  const verdict = sql`${supportAiSuggestions.payload}->>'sentiment'`;
  const inWindow = sql`${supportAiSuggestions.createdAt} >= ${window.from}`;

  const [row] = await db
    .select({
      positive: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'positive')::int`,
      neutral: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'neutral')::int`,
      negative: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'negative')::int`,
      everCount: sql<number>`count(*)::int`,
    })
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
        sql`${supportAiSuggestions.status} <> 'rejected'`,
        eq(supportTickets.clientPartyId, partyId),
      ),
    );

  return sentimentFactor(
    {
      sourceInUse,
      positive: row?.positive ?? 0,
      neutral: row?.neutral ?? 0,
      negative: row?.negative ?? 0,
      observedEver: (row?.everCount ?? 0) > 0,
    },
    window,
  );
}

/**
 * Usage, from the only per-customer usage fact this system holds.
 *
 * A `usage-decline` lifecycle signal, joined through the customer's contracts.
 * See `usageFactor` for why this is a weak source and why saying so is better
 * than substituting a number: there is no product telemetry in this schema,
 * and a customer nobody has observed must not be scored as one observed to be
 * fine.
 */
export async function readUsage(
  db: Db,
  organizationId: string,
  partyId: string,
  window: ReturnType<typeof healthWindow>,
  sourceInUse: boolean,
): Promise<HealthFactor> {
  const [row] = await db
    .select({
      observationCount: sql<number>`count(*) FILTER (WHERE ${customerLifecycleSignals.observedAt} >= ${window.from})::int`,
      declineImpact: sql<number>`coalesce(sum(${customerLifecycleSignals.impact}) FILTER (WHERE ${customerLifecycleSignals.observedAt} >= ${window.from}), 0)::int`,
      everCount: sql<number>`count(*)::int`,
    })
    .from(customerLifecycleSignals)
    /**
     * An explicit join rather than the relational include API, and tenant
     * matched on both columns. The signal table carries no `party_id` of its
     * own — the contract does — so this is the edge that turns "evidence about
     * a contract" into "evidence about a customer".
     */
    .innerJoin(
      customerLifecycles,
      and(
        eq(
          customerLifecycles.customerLifecycleId,
          customerLifecycleSignals.customerLifecycleId,
        ),
        eq(
          customerLifecycles.organizationId,
          customerLifecycleSignals.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(customerLifecycleSignals.organizationId, organizationId),
        eq(customerLifecycleSignals.kind, "usage-decline"),
        eq(customerLifecycles.partyId, partyId),
      ),
    );

  return usageFactor(
    {
      sourceInUse,
      observationCount: row?.observationCount ?? 0,
      declineImpact: row?.declineImpact ?? 0,
      observedEver: (row?.everCount ?? 0) > 0,
    },
    window,
  );
}

/**
 * `max(timestamp)` comes back as a `Date` from the driver and as a string from
 * some paths; normalised here rather than trusted, because an unparsed string
 * arithmetic'd against a `Date` yields `NaN` days and a silent zero for recency.
 */
function coerceDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
