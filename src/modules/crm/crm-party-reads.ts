import { and, eq, sql } from "drizzle-orm";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
} from "../../db/schema/party";

/**
 * The read side of the Party seam, for the queries a resolver cannot answer.
 *
 * `party-legacy-seam.ts` answers "which Party is this lead?", one id or a batch
 * of them at a time. A screen that filters, groups, sorts or counts on the
 * record's own fields is asking something no per-id resolver can: it needs the
 * Party rows inside the query. This is the one place that join is spelled, so
 * the tenant predicate on both sides of it is written once instead of once per
 * call site — a read moving to a new table is exactly when an `organization_id`
 * predicate goes missing.
 *
 * The `*_party_map` table leads and `business_parties` is joined onto it rather
 * than the other way round, for two reasons. The map's primary key is
 * `(organization_id, legacy_id)`, so the join produces exactly the rows the
 * legacy table produced and cannot multiply them. And the legacy id stays
 * selectable, which matters because every URL this module emits still carries
 * one.
 */

/**
 * The join condition, tenant on both sides.
 *
 * The composite foreign key behind `*_party_map` already makes a cross-tenant
 * party unreachable; restating it here means a hand-written `party_id` in a
 * `WHERE` cannot reach one either.
 */
export const PARTY_OF_LEAD = and(
  eq(businessParties.partyId, leadPartyMap.partyId),
  eq(businessParties.organizationId, leadPartyMap.organizationId),
);

export const PARTY_OF_CLIENT = and(
  eq(businessParties.partyId, clientPartyMap.partyId),
  eq(businessParties.organizationId, clientPartyMap.organizationId),
);

export const PARTY_OF_CONTACT = and(
  eq(businessParties.partyId, contactPartyMap.partyId),
  eq(businessParties.organizationId, contactPartyMap.organizationId),
);

/** The fourth, from ticket 25: a company id and the party it became. */
export const PARTY_OF_CRM_ORG = and(
  eq(businessParties.partyId, crmOrgPartyMap.partyId),
  eq(businessParties.organizationId, crmOrgPartyMap.organizationId),
);

/*
 * The columns whose legacy counterpart is NOT NULL where Party's is nullable.
 *
 * `party-mirror-fields.ts` fills these in on the way out — a null
 * `lifecycle_stage` is a lead that never left NEW, a null `acquisition_source`
 * is `other` — so a query reading the Party column raw would filter and group on
 * a null the legacy table never showed, and `NOT IN (…)` against it drops the
 * row entirely. Same defaults, in SQL because a WHERE clause cannot call the
 * mirror. If one of them changes there, it changes here.
 */

/** `leads.status`: the pipeline position, NEW · CONTACTED · QUALIFIED · … */
export const leadStatus = sql<string>`coalesce(${businessParties.lifecycleStage}, 'NEW')`;

/** `leads.priority`: HOT · WARM · COLD. */
export const leadPriority = sql<string>`coalesce(${businessParties.priority}, 'WARM')`;

/** `leads.source`. */
export const leadSource = sql<string>`coalesce(${businessParties.acquisitionSource}, 'other')`;

/** `clients.health_score`, which defaults to 50 where Party leaves it unscored. */
export const clientHealthScore = sql<number>`coalesce(${businessParties.healthScore}, 50)`;
