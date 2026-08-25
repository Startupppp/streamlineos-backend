import { eq, sql, type SQL } from "drizzle-orm";
import { businessParties, clientPartyMap } from "../../db/schema/party";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";

/**
 * Where this module's reads get their clients.
 *
 * Ticket 02 made Party canonical and `clients` a mirror derived from it, so a
 * `SELECT ... FROM clients` is a read of a copy — correct until the mirror lags,
 * and gone entirely when ticket 08 drops the table. Every read here goes through
 * `client_party_map` instead: the map supplies the numeric id that URLs, foreign
 * keys and CSV columns still speak, and `business_parties` supplies the values.
 *
 * Same three responsibilities as `leads/lead-party-reader.ts`, which this
 * deliberately mirrors rather than generalises — the two share a shape, not a
 * column list, and a single parameterised reader would spend its life narrowing
 * a union back to whichever kind the caller already knew it had.
 *
 * The tenant is asserted on the map row *and* carried across the join. The
 * composite foreign key behind `client_party_map` already makes a cross-tenant
 * party unreachable; restating it means a hand-written `party_id` in a WHERE
 * cannot reach one either.
 *
 * The column names stay the ones `clients` used. The health dashboard, the churn
 * export and the CSV header all speak that vocabulary, and renaming the keys
 * under them would move a rename out of this seam and into every caller.
 *
 * **What makes a party a client is a role, not a table.** `party_roles` carries
 * CUSTOMER (and VENDOR alongside it, because one business is routinely both),
 * written by `party-legacy-clients.ts` on every create and adopt. The map is
 * matched on here only because it still carries the numeric id every URL, CSV
 * column and foreign key in this module emits; when ticket 08 drops `clients`
 * the map goes with it and the role is the whole of the distinction. Reading the
 * role in its place is that ticket's work, not a second answer to add beside
 * this one now.
 */

/**
 * The values the mirror substitutes where Party is null.
 *
 * `clients.health_score` and `.health_status` are NOT NULL and Party's are not:
 * a party that has never been a customer has no health, and defaulting it to
 * "50, healthy" would put every lead in the org on the health dashboard looking
 * deliberately scored. `party-mirror-fields.ts` fills them in on the way out, and
 * a SQL predicate cannot call that derivation — so the fallback exists twice and
 * is named here so the two are one literal rather than two copies of it.
 */
export const CLIENT_MIRROR_DEFAULTS = {
  healthScore: 50,
  healthStatus: "healthy",
} as const;

/**
 * Party columns under the names `clients` gave them.
 *
 * Usable in a projection, a predicate, a GROUP BY and an ORDER BY alike, which
 * is what keeps a filter and the column it filters on from disagreeing.
 */
export const CLIENT_PARTY_COLUMNS = {
  id: clientPartyMap.clientId,
  partyId: businessParties.partyId,
  orgId: businessParties.organizationId,
  name: businessParties.name,
  email: businessParties.email,
  phone: businessParties.phone,
  company: businessParties.companyName,
  designation: businessParties.jobTitle,
  city: businessParties.city,
  state: businessParties.state,
  gstin: businessParties.taxNumber,
  status: businessParties.status,
  notes: businessParties.notes,
  accountManagerId: businessParties.ownerUserId,
  investmentValue: businessParties.lifetimeValue,
  healthScore: sql<number>`coalesce(${businessParties.healthScore}, ${CLIENT_MIRROR_DEFAULTS.healthScore})`,
  healthStatus: sql<string>`coalesce(${businessParties.healthStatus}, ${CLIENT_MIRROR_DEFAULTS.healthStatus})`,
  churnRiskScore: businessParties.churnRiskScore,
  churnRiskReasoning: businessParties.churnRiskReasoning,
  lastHealthCheck: businessParties.healthCheckedAt,
  convertedAt: businessParties.convertedAt,
  createdAt: businessParties.createdAt,
  updatedAt: businessParties.updatedAt,
} as const;

/**
 * The join every client read starts from.
 *
 * One SQL fragment rather than `and(...)` so it is a `SQL` and not a
 * `SQL | undefined` each call site would have to assert away.
 */
export const CLIENT_PARTY_JOIN: SQL = sql`${businessParties.partyId} = ${clientPartyMap.partyId} and ${businessParties.organizationId} = ${clientPartyMap.organizationId}`;

/**
 * Tenant scope for a client read.
 *
 * Both sides of the join carry the predicate. The join already forces them
 * equal, so the second `eq` adds no rows — it adds the index: every useful index
 * on `business_parties` leads with `organization_id`, and stating it on that side
 * is what lets the planner start there.
 *
 * No `deleted_at` predicate, deliberately. `clients` has no such column, so the
 * legacy surface has never hidden a client — see `softDeletePartyWithMirror`,
 * which reports that gap rather than closing it. Filtering on the party's
 * `deleted_at` here would newly hide a record the moment some other module
 * soft-deleted the party behind it, which is a behaviour change this batch is
 * not allowed to make.
 */
export function clientPartyScope(orgId: string): SQL[] {
  return [
    eq(clientPartyMap.organizationId, orgId),
    eq(businessParties.organizationId, orgId),
  ];
}

/**
 * The viewer's data scope, as a predicate over the client's owner.
 *
 * `owner_user_id` is `clients.account_manager_id` under the merged model's name,
 * so "own" still means "the account I manage" and no scope changed meaning here.
 */
export function clientPartyViewScope(orgId: string, userId: string, scope: DataScope): SQL {
  return applyScope(scope, orgId, userId, { ownerColumn: businessParties.ownerUserId });
}

/** One client, by the numeric id everything outside Party still holds. */
export function clientIdIs(clientId: number): SQL {
  return eq(clientPartyMap.clientId, clientId);
}
