import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { crmAccountTierEnum, feedbackPosts } from "../../../db/schema";
import { businessParties, crmOrgPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CRM_ORG } from "../../crm/crm-party-reads";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { roundToScoreDecimals, type RoadmapPrioritization } from "./roadmap-prioritization";

export type RoadmapAccountTier = (typeof crmAccountTierEnum.enumValues)[number];

/**
 * What a customer's tier multiplies its requests by, and the order the tiers
 * stand in. Both are `Record<RoadmapAccountTier, number>`, so a fourth label on
 * `crm_account_tier` fails to compile here until somebody prices it.
 */
export const ROADMAP_TIER_WEIGHTS: Record<RoadmapAccountTier, number> = {
  free: 1,
  pro: 2,
  enterprise: 4,
};

export const ROADMAP_TIER_RANKS: Record<RoadmapAccountTier, number> = {
  free: 1,
  pro: 2,
  enterprise: 3,
};

export const ROADMAP_TIER_UNWEIGHTED_REASONS = [
  "no_linked_feedback",
  "no_linked_account",
  "account_tier_unset",
  "score_unavailable",
] as const;
export type RoadmapTierUnweightedReason = (typeof ROADMAP_TIER_UNWEIGHTED_REASONS)[number];

const RANKED_TIERS: readonly RoadmapAccountTier[] = crmAccountTierEnum.enumValues;
const TIER_BY_RANK = new Map<number, RoadmapAccountTier>(
  RANKED_TIERS.map((tier) => [ROADMAP_TIER_RANKS[tier], tier]),
);

export interface RoadmapAccountTierSummary {
  linkedFeedbackCount: number;
  linkedAccountCount: number;
  topTier: RoadmapAccountTier | null;
  linkedRevenue: number | null;
  revenueKnownAccountCount: number;
}

export interface RoadmapTierWeighting {
  tierWeighted: boolean;
  tier: RoadmapAccountTier | null;
  weight: number | null;
  weightedScore: number | null;
  unweightedReason: RoadmapTierUnweightedReason | null;
  linkedFeedbackCount: number;
  linkedAccountCount: number;
  linkedRevenue: number | null;
  revenueKnownAccountCount: number;
}

const EMPTY_ACCOUNT_TIER_SUMMARY: RoadmapAccountTierSummary = {
  linkedFeedbackCount: 0,
  linkedAccountCount: 0,
  topTier: null,
  linkedRevenue: null,
  revenueKnownAccountCount: 0,
};

function unweighted(
  summary: RoadmapAccountTierSummary,
  unweightedReason: RoadmapTierUnweightedReason,
  tier: RoadmapAccountTier | null,
): RoadmapTierWeighting {
  return {
    tierWeighted: false,
    tier,
    weight: null,
    weightedScore: null,
    unweightedReason,
    linkedFeedbackCount: summary.linkedFeedbackCount,
    linkedAccountCount: summary.linkedAccountCount,
    linkedRevenue: summary.linkedRevenue,
    revenueKnownAccountCount: summary.revenueKnownAccountCount,
  };
}

export function applyRoadmapTierWeighting(
  prioritization: RoadmapPrioritization,
  summary: RoadmapAccountTierSummary = EMPTY_ACCOUNT_TIER_SUMMARY,
): RoadmapTierWeighting {
  if (summary.linkedFeedbackCount <= 0) return unweighted(summary, "no_linked_feedback", null);
  if (summary.linkedAccountCount <= 0) return unweighted(summary, "no_linked_account", null);
  if (summary.topTier === null) return unweighted(summary, "account_tier_unset", null);
  if (prioritization.score === null)
    return unweighted(summary, "score_unavailable", summary.topTier);

  const weight = ROADMAP_TIER_WEIGHTS[summary.topTier];
  return {
    tierWeighted: true,
    tier: summary.topTier,
    weight,
    weightedScore: roundToScoreDecimals(prioritization.score * weight),
    unweightedReason: null,
    linkedFeedbackCount: summary.linkedFeedbackCount,
    linkedAccountCount: summary.linkedAccountCount,
    linkedRevenue: summary.linkedRevenue,
    revenueKnownAccountCount: summary.revenueKnownAccountCount,
  };
}

/**
 * The tier rank expression, built from `ROADMAP_TIER_RANKS` rather than spelled
 * a second time in SQL. `MAX` over it is the highest tier in the group, and a
 * company with no tier contributes NULL rather than a floor.
 */
function topTierRankExpression() {
  const branches = RANKED_TIERS.map(
    (tier) =>
      sql`WHEN ${businessParties.tier}::text = ${tier} THEN ${ROADMAP_TIER_RANKS[tier]}::int`,
  );
  return sql`MAX(CASE ${sql.join(branches, sql` `)} ELSE NULL END)`;
}

/**
 * What the linked accounts are worth, counted once per account rather than once
 * per feedback post. Two posts from the same company are two votes but one
 * balance, so `jsonb_object_agg` keys the values by company id before they are
 * summed — the key collapses the duplicates, and every row for one company
 * carries the same `lifetime_value`, so which duplicate survives does not matter.
 *
 * A company with no `lifetime_value` is filtered out rather than read as zero:
 * `revenueKnownAccountCount` is what says how much of the total is actually
 * known, and a total of NULL is "nobody told us", not "worth nothing".
 */
function linkedRevenueExpression() {
  const knownValues = sql`jsonb_object_agg(
      ${feedbackPosts.crmOrganizationId}::text,
      ${businessParties.lifetimeValue}
    ) FILTER (
      WHERE ${feedbackPosts.crmOrganizationId} IS NOT NULL
        AND ${businessParties.lifetimeValue} IS NOT NULL
    )`;
  return sql<
    string | null
  >`(SELECT SUM(entry.value::numeric) FROM jsonb_each_text(COALESCE(${knownValues}, '{}'::jsonb)) AS entry(key, value))`;
}

/**
 * Every linked account's tier for a whole page of roadmap items, in one grouped
 * query (BE-47). The alternative — a lookup per item — is the shape the board
 * would have taken, and it scales with the page size.
 */
export async function loadRoadmapAccountTiers(
  db: Db | TenantTx,
  orgId: string,
  itemIds: readonly number[],
): Promise<Map<number, RoadmapAccountTierSummary>> {
  const resolved = new Map<number, RoadmapAccountTierSummary>();
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return resolved;

  const rows = await db
    .select({
      itemId: feedbackPosts.linkedRoadmapItemId,
      linkedFeedbackCount: sql<number>`COUNT(*)::int`.mapWith(Number),
      linkedAccountCount:
        sql<number>`COUNT(DISTINCT ${feedbackPosts.crmOrganizationId})::int`.mapWith(Number),
      topTierRank: topTierRankExpression(),
      linkedRevenue: linkedRevenueExpression(),
      revenueKnownAccountCount: sql<number>`COUNT(DISTINCT ${feedbackPosts.crmOrganizationId})
        FILTER (WHERE ${businessParties.lifetimeValue} IS NOT NULL)::int`.mapWith(Number),
    })
    .from(feedbackPosts)
    .leftJoin(
      crmOrgPartyMap,
      and(
        eq(crmOrgPartyMap.organizationId, feedbackPosts.orgId),
        eq(crmOrgPartyMap.crmOrganizationId, feedbackPosts.crmOrganizationId),
      ),
    )
    .leftJoin(
      businessParties,
      and(PARTY_OF_CRM_ORG, eq(businessParties.partyKind, "ORGANISATION"), isNull(businessParties.deletedAt)),
    )
    .where(
      and(
        eq(feedbackPosts.orgId, orgId),
        inArray(feedbackPosts.linkedRoadmapItemId, ids),
        isNull(feedbackPosts.deletedAt),
        isNull(feedbackPosts.duplicateOfId),
      ),
    )
    .groupBy(feedbackPosts.linkedRoadmapItemId);

  for (const row of rows) {
    if (row.itemId === null) continue;
    const rank = row.topTierRank === null || row.topTierRank === undefined ? null : Number(row.topTierRank);
    const revenueKnownAccountCount = Number(row.revenueKnownAccountCount ?? 0);
    resolved.set(row.itemId, {
      linkedFeedbackCount: Number(row.linkedFeedbackCount),
      linkedAccountCount: Number(row.linkedAccountCount),
      topTier: rank === null ? null : (TIER_BY_RANK.get(rank) ?? null),
      linkedRevenue:
        revenueKnownAccountCount === 0 || row.linkedRevenue === null || row.linkedRevenue === undefined
          ? null
          : roundToScoreDecimals(Number(row.linkedRevenue)),
      revenueKnownAccountCount,
    });
  }
  return resolved;
}

/**
 * The company id space `feedback_posts.crm_organization_id` speaks is
 * `crm_org_party_map`'s, not `business_parties`' — so an id is real only when
 * the map row and the party it names are both in the caller's tenant. A miss is
 * a 404 rather than a 403 (BE-91): a 403 would confirm the company exists.
 */
export async function assertCrmOrganizationInOrg(
  db: Db | TenantTx,
  orgId: string,
  crmOrganizationId: number | null | undefined,
): Promise<void> {
  if (crmOrganizationId === undefined || crmOrganizationId === null) return;
  const [row] = await db
    .select({ id: crmOrgPartyMap.crmOrganizationId })
    .from(crmOrgPartyMap)
    .innerJoin(businessParties, PARTY_OF_CRM_ORG)
    .where(
      and(
        eq(crmOrgPartyMap.crmOrganizationId, crmOrganizationId),
        eq(crmOrgPartyMap.organizationId, orgId),
        eq(businessParties.organizationId, orgId),
        eq(businessParties.partyKind, "ORGANISATION"),
        isNull(businessParties.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Organization not found");
}
