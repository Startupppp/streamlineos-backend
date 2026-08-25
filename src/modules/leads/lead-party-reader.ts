import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";
import { LEAD_MIRROR, type PartyRow } from "../party/party-legacy-mirror";
import type { LeadInsert } from "../party/party-legacy-writer";

/**
 * Where this module's reads get their leads.
 *
 * Ticket 02 made Party canonical and `leads` a mirror derived from it, which
 * means a `SELECT ... FROM leads` is now a read of a copy: correct until the
 * moment the mirror lags, and gone entirely when ticket 08 drops the table. Every
 * read in this module goes through here instead — `lead_party_map` supplies the
 * numeric id that URLs, foreign keys and CSV columns still speak, and
 * `business_parties` supplies the values.
 *
 * Three things this file is responsible for keeping true:
 *
 * The tenant is asserted on the map row *and* carried across the join, so a
 * party in another organisation is unreachable even if a map row's `party_id`
 * were tampered with — the composite foreign key behind the join is what makes
 * that a fact rather than a hope. Every caller adds `orgId` because the seam
 * refuses to build a predicate without one.
 *
 * The column names stay the ones `leads` used. Not nostalgia: the scoring rules,
 * the assignment rules and the pipeline blueprints all store a *field name* that
 * a tenant chose against the legacy vocabulary (`score`, `city`, `status`), and
 * renaming the keys under them would silently stop those rules matching. The
 * translation happens here, once, in the direction `party-mirror-fields.ts`
 * already declares.
 *
 * A lead is a party with a `lead_party_map` row — not a party holding the
 * PROSPECT role. A converted lead keeps its map row exactly as it kept its
 * `leads` row, so the lists that have always shown converted leads still do.
 */

/**
 * The values the mirror substitutes where Party is null.
 *
 * `leads.status`, `.priority` and `.source` are NOT NULL and Party's columns are
 * not, so `party-mirror-fields.ts` supplies a default on the way out. A SQL
 * predicate cannot call that derivation, so the fallback has to exist twice —
 * once in SQL, once in TypeScript. It is named here and interpolated into both
 * so the two are the same literal rather than two copies of it: change
 * `party-mirror-fields.ts` and this is the single line that follows.
 */
export const LEAD_MIRROR_DEFAULTS = {
  status: "NEW",
  priority: "WARM",
  source: "other",
} as const;

/**
 * Party columns under the names `leads` gave them.
 *
 * Usable in a projection, a predicate, a GROUP BY and an ORDER BY alike, which
 * is what keeps a filter and the column it filters on from disagreeing.
 */
export const LEAD_PARTY_COLUMNS = {
  id: leadPartyMap.leadId,
  partyId: businessParties.partyId,
  orgId: businessParties.organizationId,
  name: businessParties.name,
  email: businessParties.email,
  phone: businessParties.phone,
  whatsappNumber: businessParties.whatsappPhone,
  source: sql<string>`coalesce(${businessParties.acquisitionSource}, ${LEAD_MIRROR_DEFAULTS.source})`,
  subSource: businessParties.acquisitionSubSource,
  campaignId: businessParties.acquisitionCampaignId,
  status: sql<string>`coalesce(${businessParties.lifecycleStage}, ${LEAD_MIRROR_DEFAULTS.status})`,
  priority: sql<string>`coalesce(${businessParties.priority}, ${LEAD_MIRROR_DEFAULTS.priority})`,
  investmentInterest: businessParties.statedBudget,
  potentialValue: businessParties.expectedValue,
  notes: businessParties.notes,
  assignedToId: businessParties.ownerUserId,
  assignedById: businessParties.assignedByUserId,
  verifiedById: businessParties.verifiedByUserId,
  assignedAt: businessParties.assignedAt,
  convertedAt: businessParties.convertedAt,
  lostReason: businessParties.lostReason,
  company: businessParties.companyName,
  designation: businessParties.jobTitle,
  city: businessParties.city,
  referredBy: businessParties.referredBy,
  tags: businessParties.tags,
  score: businessParties.qualificationScore,
  slaDeadline: businessParties.slaDueAt,
  website: businessParties.website,
  followUpDate: businessParties.nextFollowUpAt,
  followUpNotes: businessParties.followUpNotes,
  customData: businessParties.customFields,
  createdAt: businessParties.createdAt,
  updatedAt: businessParties.updatedAt,
  deletedAt: businessParties.deletedAt,
} as const;

/**
 * The join every lead read starts from.
 *
 * Written as one SQL fragment rather than `and(...)` so it is a `SQL` and not a
 * `SQL | undefined` that each call site would have to assert away.
 */
export const LEAD_PARTY_JOIN: SQL = sql`${businessParties.partyId} = ${leadPartyMap.partyId} and ${businessParties.organizationId} = ${leadPartyMap.organizationId}`;

/**
 * Tenant scope for a lead read.
 *
 * Both sides of the join carry the predicate. The join already forces them
 * equal, so the second `eq` adds no rows — it adds the index: every useful index
 * on `business_parties` leads with `organization_id`, and stating it on that
 * side is what lets the planner start there.
 *
 * `includeDeleted` exists for the one read that has always ignored the flag —
 * the duplicate check behind lead creation, which must still see a deleted
 * record so that re-entering a deleted lead is reported rather than silently
 * duplicated.
 */
export function leadPartyScope(
  orgId: string,
  options: { includeDeleted?: boolean } = {},
): SQL[] {
  const scope: SQL[] = [
    eq(leadPartyMap.organizationId, orgId),
    eq(businessParties.organizationId, orgId),
  ];
  if (!options.includeDeleted) scope.push(isNull(businessParties.deletedAt));
  return scope;
}

/**
 * The viewer's data scope, as a predicate over the lead's owner.
 *
 * `owner_user_id` is `leads.assigned_to_id` under the merged model's name, so
 * "own" still means "assigned to me" and no scope changed meaning here. It lives
 * beside the columns rather than beside each caller because the list and the
 * board were asking the same question in two places, and a scope that means one
 * thing on one screen and something else on the next is exactly the drift this
 * seam exists to prevent.
 *
 * No scope leaves the predicate off, for the callers that pass `undefined`
 * because the read was authorised somewhere else.
 */
export function pushLeadPartyViewScope(
  where: SQL[],
  orgId: string,
  scope: DataScope | undefined,
  userId: string | undefined,
): void {
  if (!scope) return;
  if (scope === "none") {
    where.push(sql`false`);
    return;
  }
  if (!userId) return;
  where.push(applyScope(scope, orgId, userId, { ownerColumn: businessParties.ownerUserId }));
}

/**
 * For the reads that have always seen a deleted lead, and must keep seeing one.
 *
 * Two kinds of caller need it. A duplicate check asks "has this person been
 * entered before", and a deleted duplicate is still a duplicate. An after-effect
 * of a write — scoring, SLA, assignment rules — is finishing work on a record
 * that may have been deleted a moment ago, and skipping it would leave the
 * record half-processed rather than untouched.
 */
export const INCLUDE_DELETED = { includeDeleted: true } as const;

/** One lead, by the numeric id everything outside Party still holds. */
export function leadIdIs(leadId: number): SQL {
  return eq(leadPartyMap.leadId, leadId);
}

/** Many leads, by the ids a bulk request arrived with. */
export function leadIdIn(leadIds: readonly number[]): SQL {
  return inArray(leadPartyMap.leadId, [...leadIds]);
}

/**
 * A whole lead, in the vocabulary the rest of the module reads it in.
 *
 * `Partial<LeadInsert>` because that is what `LEAD_MIRROR.derive` returns — it
 * is the type of a *patch*, and the derivation is total over every column it
 * owns. The intersection re-states the columns `leads` declares NOT NULL so a
 * caller does not have to narrow what was never nullable.
 */
export type LeadView = Partial<LeadInsert> & {
  id: number;
  partyId: string;
  orgId: string;
  name: string;
  status: string;
  priority: string;
  source: string;
  score: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/**
 * The legacy row this Party row means.
 *
 * The values come from `LEAD_MIRROR.derive` and nowhere else, so this module
 * reads exactly what the writer would have written — there is one derivation and
 * this is not a second one. The `??` arms are unreachable for that reason: they
 * narrow `Partial<LeadInsert>` to the NOT NULL shape, they do not decide it.
 */
export function leadViewFrom(leadId: number, party: PartyRow): LeadView {
  const derived = LEAD_MIRROR.derive(party);
  return {
    ...derived,
    id: leadId,
    partyId: party.partyId,
    orgId: party.organizationId,
    name: derived.name ?? party.name,
    status: derived.status ?? LEAD_MIRROR_DEFAULTS.status,
    priority: derived.priority ?? LEAD_MIRROR_DEFAULTS.priority,
    source: derived.source ?? LEAD_MIRROR_DEFAULTS.source,
    score: derived.score ?? 0,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    deletedAt: party.deletedAt,
  };
}

interface LeadPartyRow {
  leadId: number;
  party: PartyRow;
}

async function selectLeadParties(
  db: Db,
  orgId: string,
  conditions: SQL[],
  options: { includeDeleted?: boolean } = {},
): Promise<LeadPartyRow[]> {
  if (!orgId) return [];
  return db
    .select({ leadId: leadPartyMap.leadId, party: businessParties })
    .from(leadPartyMap)
    .innerJoin(businessParties, LEAD_PARTY_JOIN)
    .where(and(...leadPartyScope(orgId, options), ...conditions));
}

/**
 * One lead as a whole row, or undefined.
 *
 * Undefined rather than a throw: during the migration a miss is ordinary — a
 * lead in another tenant, a deleted one, a row whose party never arrived — and
 * every caller here already had a `null`/404 branch for it.
 */
export async function loadLeadView(
  db: Db,
  orgId: string,
  leadId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<LeadView | undefined> {
  if (!Number.isInteger(leadId)) return undefined;
  const [row] = await selectLeadParties(db, orgId, [leadIdIs(leadId)], options);
  return row ? leadViewFrom(row.leadId, row.party) : undefined;
}

/** Many leads as whole rows. One query, because a list must not cost one each. */
export async function loadLeadViews(
  db: Db,
  orgId: string,
  leadIds: readonly number[],
  options: { includeDeleted?: boolean } = {},
): Promise<LeadView[]> {
  const ids = [...new Set(leadIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  const rows = await selectLeadParties(db, orgId, [leadIdIn(ids)], options);
  return rows.map((row) => leadViewFrom(row.leadId, row.party));
}
