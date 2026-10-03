import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

export function sourceSpaceFilter(accessibleSpaceIds: number[]): SQL | undefined {
  return accessibleSpaceIds.length > 0
    ? or(isNull(kbSources.spaceId), inArray(kbSources.spaceId, accessibleSpaceIds))
    : isNull(kbSources.spaceId);
}

export async function assertRequestedSourcesVisible(
  db: Db,
  orgId: string,
  accessibleSpaceIds: number[],
  sourceIds: number[],
): Promise<void> {
  const rows = await db
    .select({ id: kbSources.id })
    .from(kbSources)
    .where(
      and(
        eq(kbSources.orgId, orgId),
        inArray(kbSources.id, sourceIds),
        isNull(kbSources.deletedAt),
        sourceSpaceFilter(accessibleSpaceIds),
      ),
    )
    .limit(sourceIds.length);
  const visible = new Set(rows.map((row) => row.id));
  if (sourceIds.some((id) => !visible.has(id)))
    throw new NotFoundException("One or more sources not found");
}
