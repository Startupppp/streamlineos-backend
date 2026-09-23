import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  broadcastAudienceTargets,
  broadcastReadReceipts,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import {
  audienceKindFor,
  type AnnouncementTargetType,
} from "./org-announcement-broadcast";

export const MAX_ANNOUNCEMENT_TARGETS = 1000;
export const MAX_BRANCH_RECIPIENTS = 5000;

export function dedupeTargetIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))].slice(
    0,
    MAX_ANNOUNCEMENT_TARGETS,
  );
}

export async function readAnnouncementReadCounts(
  db: Db,
  orgId: string,
  ids: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (ids.length === 0) return counts;
  const rows = await db
    .select({
      broadcastId: broadcastReadReceipts.broadcastId,
      total: sql<number>`count(*)::int`,
    })
    .from(broadcastReadReceipts)
    .where(
      and(
        eq(broadcastReadReceipts.orgId, orgId),
        inArray(broadcastReadReceipts.broadcastId, ids),
      ),
    )
    .groupBy(broadcastReadReceipts.broadcastId)
    .limit(ids.length);
  for (const row of rows) counts.set(row.broadcastId, Number(row.total));
  return counts;
}

export async function resolveAnnouncementRecipients(
  tx: Db,
  orgId: string,
  targetType: AnnouncementTargetType,
  requestedIds: string[],
): Promise<string[]> {
  if (targetType === "ALL") return [];
  if (targetType !== "BRANCH") return requestedIds;
  if (requestedIds.length === 0) return [];

  const rows = await tx
    .select({ userId: organizationMembers.userId })
    .from(orgUnitMembers)
    .innerJoin(
      orgUnits,
      and(
        eq(orgUnits.orgId, orgUnitMembers.orgId),
        eq(orgUnits.id, orgUnitMembers.orgUnitId),
        eq(orgUnits.kind, "BRANCH"),
        isNull(orgUnits.deletedAt),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, orgUnitMembers.orgId),
        eq(organizationMembers.id, orgUnitMembers.membershipId),
      ),
    )
    .where(
      and(
        eq(orgUnitMembers.orgId, orgId),
        inArray(orgUnitMembers.orgUnitId, requestedIds),
      ),
    )
    .limit(MAX_BRANCH_RECIPIENTS + 1);

  if (rows.length > MAX_BRANCH_RECIPIENTS) {
    throw new BadRequestException(
      "Branch audience is larger than an announcement can address",
    );
  }
  return [...new Set(rows.map((row) => row.userId))];
}

export async function writeAnnouncementTargets(
  tx: Db,
  orgId: string,
  broadcastId: number,
  targetType: AnnouncementTargetType,
  ids: string[],
): Promise<void> {
  const kind = audienceKindFor(targetType);
  if (kind === null || ids.length === 0) return;
  await tx
    .insert(broadcastAudienceTargets)
    .values(ids.map((targetId) => ({ orgId, broadcastId, kind, targetId })));
}

export async function clearAnnouncementTargets(
  tx: Db,
  orgId: string,
  broadcastId: number,
): Promise<void> {
  await tx
    .delete(broadcastAudienceTargets)
    .where(
      and(
        eq(broadcastAudienceTargets.orgId, orgId),
        eq(broadcastAudienceTargets.broadcastId, broadcastId),
      ),
    );
}
