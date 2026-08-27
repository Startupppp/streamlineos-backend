import type { ActivityKind } from "../../db/schema/crm/activities";

/**
 * What attribution is allowed to know about a touch.
 *
 * Phase 6, ticket 18. Every field here is copied off one `activities` row and
 * nothing is derived, because the ticket's fourth criterion — attribution never
 * invents a touch that is not on the timeline — is only checkable if a touch
 * carries the identity of the row it came from. `activityId` is therefore not
 * decoration on a credit; it is the credit's proof, and `attributeConversion`
 * refuses a touch without one.
 *
 * The timeline is the source because it is the only store that holds every
 * channel. `activities` is what ticket 10's ingress writes into, from mail,
 * calendar, telephony and the CRM's own screens, so "attributed across every
 * touch that contributed" is a claim this table can actually support.
 *
 * ## `crm_lead_touchpoints` is not a second source of touches
 *
 * There is an older table — `crm_lead_touchpoints`, read by
 * `crm-attribution-report.service.ts` — and it is deliberately not read here.
 * It is a narrower shape that this module supersedes, for reasons that are
 * structural rather than aesthetic:
 *
 *   - it is keyed on `lead_id`, an integer identity that phase 2 is removing,
 *     so a credit tracing to one would trace to a row that will not exist;
 *   - it cannot describe a touch that is not a lead's — no deal, no party, no
 *     thread — so it cannot answer for a customer who was never a lead, which
 *     is most of them after the first sale;
 *   - it carries no timeline id, so a credit derived from it could not satisfy
 *     the criterion above even in principle;
 *   - the service reading it attributes the WHOLE deal value to each campaign
 *     group it joins, so two campaigns that both touched a deal each report all
 *     of it. That is the "attributed to whichever one happened last" failure the
 *     ticket opens with, in its double-counting form.
 *
 * It is not dead, and pretending otherwise would be the other kind of dishonest:
 * `recordTouch` is still called when a lead is created, and the campaigns screen
 * still reads it. What it holds that the timeline does not is the campaign and
 * the UTM parameters. Superseding it completely therefore needs those to arrive
 * on `activities` at the ingress seam — until they do, this module attributes by
 * channel and the campaign roll-up stays where it is. What must NOT happen is a
 * second touch store: this file reads `activities` and only `activities`.
 */
export interface AttributionTouch {
  /** The `activities` row this came from. A credit without one is not a credit. */
  readonly activityId: string;
  readonly occurredAt: Date;
  readonly kind: ActivityKind;
  /**
   * `activities.source` — `manual`, or the adapter that produced the row.
   *
   * Deliberately the channel rather than a campaign: this is the fact the
   * timeline actually holds, and reporting a campaign it does not hold would be
   * inventing the very thing the fourth criterion forbids.
   */
  readonly channel: string;
  readonly partyId: string | null;
  readonly dealId: string | null;
}

/**
 * The revenue being attributed, and when it landed.
 *
 * Money in integer minor units, as everywhere. `convertedAt` bounds the
 * timeline: a touch after the deal closed did not contribute to closing it, and
 * including one would let post-sale support mail take credit for the sale.
 */
export interface Conversion {
  readonly dealId: string;
  readonly organizationId: string;
  readonly currency: string;
  readonly valueMinor: number;
  readonly convertedAt: Date;
}

/**
 * Chronological, oldest first, with the timeline id breaking ties.
 *
 * Not a nicety: first-touch and last-touch are defined by position, and
 * `occurred_at` collides constantly — an imported mail folder writes hundreds of
 * rows in the same second. Ordering on the timestamp alone would make "the first
 * touch" depend on the order the database happened to return rows in, so the
 * same deal under the same model would attribute differently between two reads.
 * The composite is the same total order `idx_activities_party_timeline` uses.
 */
export function orderTouches(touches: readonly AttributionTouch[]): AttributionTouch[] {
  return [...touches].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.activityId.localeCompare(b.activityId),
  );
}

/** Touches that could have contributed: on the timeline, at or before the close. */
export function touchesBefore(
  touches: readonly AttributionTouch[],
  convertedAt: Date,
): AttributionTouch[] {
  return orderTouches(touches).filter(
    (touch) => touch.occurredAt.getTime() <= convertedAt.getTime(),
  );
}
