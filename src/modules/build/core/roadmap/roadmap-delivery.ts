import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { feedbackPosts, projectStatuses, tickets } from "../../../../db/schema";
import type { Db, TenantTx } from "../../../../db/drizzle.types";

export const ROADMAP_DELIVERY_SOURCES = ["epic_ticket", "project", "none"] as const;
export type RoadmapDeliverySource = (typeof ROADMAP_DELIVERY_SOURCES)[number];

export const DELIVERY_COMPLETED_STATE_GROUP = "completed";
export const DELIVERY_EXCLUDED_STATE_GROUP = "cancelled";
export const DELIVERY_FALLBACK_COMPLETED_STATUS = "DONE";
export const DELIVERY_FALLBACK_EXCLUDED_STATUS = "CANCELLED";
export const DELIVERY_FALLBACK_OPEN_STATE_GROUP = "started";
export const DELIVERY_PROGRESS_PERCENT_SCALE = 100;

export const DEMAND_LIVE_FEEDBACK_STATUS = "open";

export interface RoadmapDeliveryProgress {
  projectId: number | null;
  epicTicketId: number | null;
  source: RoadmapDeliverySource;
  linkedTicketCount: number;
  countedTicketCount: number;
  completedTicketCount: number;
  progressPercent: number | null;
}

export interface RoadmapDemandSignals {
  votes: number;
  linkedFeedbackCount: number;
  openLinkedFeedbackCount: number;
}

export interface RoadmapDeliveryLink {
  projectId: number | null;
  epicTicketId: number | null;
}

export function resolveRoadmapDeliverySource(link: RoadmapDeliveryLink): RoadmapDeliverySource {
  if (link.epicTicketId !== null && link.epicTicketId !== undefined) return "epic_ticket";
  if (link.projectId !== null && link.projectId !== undefined) return "project";
  return "none";
}

export function computeProgressPercent(
  completedTicketCount: number,
  countedTicketCount: number,
): number | null {
  if (countedTicketCount <= 0) return null;
  return Math.round(
    (completedTicketCount / countedTicketCount) * DELIVERY_PROGRESS_PERCENT_SCALE,
  );
}

export async function loadRoadmapDeliveryProgress(
  db: Db | TenantTx,
  orgId: string,
  link: RoadmapDeliveryLink,
  visible: SQL,
): Promise<RoadmapDeliveryProgress> {
  const epicTicketId = link.epicTicketId ?? null;
  const projectId = link.projectId ?? null;
  const source = resolveRoadmapDeliverySource(link);
  const empty: RoadmapDeliveryProgress = {
    projectId,
    epicTicketId,
    source,
    linkedTicketCount: 0,
    countedTicketCount: 0,
    completedTicketCount: 0,
    progressPercent: null,
  };

  const linkPredicate =
    epicTicketId !== null
      ? or(eq(tickets.epicId, epicTicketId), eq(tickets.parentTicketId, epicTicketId))
      : projectId !== null
        ? eq(tickets.projectId, projectId)
        : null;
  if (linkPredicate === null || linkPredicate === undefined) return empty;

  const stateGroup = sql`COALESCE(
    ${projectStatuses.type}::text,
    CASE
      WHEN ${tickets.status} = ${DELIVERY_FALLBACK_COMPLETED_STATUS}::text THEN ${DELIVERY_COMPLETED_STATE_GROUP}::text
      WHEN ${tickets.status} = ${DELIVERY_FALLBACK_EXCLUDED_STATUS}::text THEN ${DELIVERY_EXCLUDED_STATE_GROUP}::text
      ELSE ${DELIVERY_FALLBACK_OPEN_STATE_GROUP}::text
    END
  )`;

  const [row] = await db
    .select({
      linkedTicketCount: sql<number>`COUNT(*)::int`.mapWith(Number),
      countedTicketCount:
        sql<number>`COUNT(*) FILTER (WHERE ${stateGroup} <> ${DELIVERY_EXCLUDED_STATE_GROUP}::text)::int`.mapWith(
          Number,
        ),
      completedTicketCount:
        sql<number>`COUNT(*) FILTER (WHERE ${stateGroup} = ${DELIVERY_COMPLETED_STATE_GROUP}::text)::int`.mapWith(
          Number,
        ),
    })
    .from(tickets)
    .leftJoin(
      projectStatuses,
      and(
        eq(projectStatuses.orgId, tickets.orgId),
        eq(projectStatuses.projectId, tickets.projectId),
        eq(projectStatuses.name, tickets.status),
      ),
    )
    .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), linkPredicate, visible));

  if (!row) return empty;

  return {
    ...empty,
    linkedTicketCount: row.linkedTicketCount,
    countedTicketCount: row.countedTicketCount,
    completedTicketCount: row.completedTicketCount,
    progressPercent: computeProgressPercent(row.completedTicketCount, row.countedTicketCount),
  };
}

export async function loadRoadmapDemandSignals(
  db: Db | TenantTx,
  orgId: string,
  itemId: number,
  votes: number,
): Promise<RoadmapDemandSignals> {
  const [row] = await db
    .select({
      linkedFeedbackCount: sql<number>`COUNT(*)::int`.mapWith(Number),
      openLinkedFeedbackCount:
        sql<number>`COUNT(*) FILTER (WHERE ${feedbackPosts.status}::text = ${DEMAND_LIVE_FEEDBACK_STATUS}::text)::int`.mapWith(
          Number,
        ),
    })
    .from(feedbackPosts)
    .where(
      and(
        eq(feedbackPosts.orgId, orgId),
        eq(feedbackPosts.linkedRoadmapItemId, itemId),
        isNull(feedbackPosts.deletedAt),
        isNull(feedbackPosts.duplicateOfId),
      ),
    );

  return {
    votes,
    linkedFeedbackCount: row?.linkedFeedbackCount ?? 0,
    openLinkedFeedbackCount: row?.openLinkedFeedbackCount ?? 0,
  };
}
