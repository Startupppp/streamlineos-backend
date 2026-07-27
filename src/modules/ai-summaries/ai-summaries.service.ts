import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { aiSummarySnapshots } from "../../db/schema/ai/ai-summaries";
import type { AiSummarySnapshot } from "../../db/schema/ai/ai-summaries";
import type {
  SnapshotPayload,
  SnapshotStructured,
  SnapshotDiff,
  FieldDiff,
  SnapshotWithDiff,
} from "./ai-summaries.types";

function computeFieldDiff(prior: string[], current: string[]): FieldDiff {
  const priorSet = new Set(prior);
  const currentSet = new Set(current);
  return {
    added: current.filter((v) => !priorSet.has(v)),
    removed: prior.filter((v) => !currentSet.has(v)),
    changed: [],
  };
}

function computeDiff(prior: SnapshotStructured, current: SnapshotStructured): SnapshotDiff {
  const highlights = computeFieldDiff(prior.highlights ?? [], current.highlights ?? []);
  const blockers = computeFieldDiff(prior.blockers ?? [], current.blockers ?? []);
  const nextActions = computeFieldDiff(prior.nextActions ?? [], current.nextActions ?? []);
  const isSameSnapshot =
    highlights.added.length === 0 &&
    highlights.removed.length === 0 &&
    blockers.added.length === 0 &&
    blockers.removed.length === 0 &&
    nextActions.added.length === 0 &&
    nextActions.removed.length === 0;
  return { highlights, blockers, nextActions, isSameSnapshot };
}

@Injectable()
export class AiSummariesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async saveSnapshot(
    orgId: string,
    entityType: string,
    entityId: string,
    payload: SnapshotPayload,
    userId: string,
  ): Promise<AiSummarySnapshot> {
    const [row] = await this.db
      .insert(aiSummarySnapshots)
      .values({
        orgId,
        entityType,
        entityId,
        summary: payload.summary,
        structured: payload.structured,
        citations: payload.citations,
        correlationId: payload.correlationId,
        generatedBy: userId,
      })
      .returning();
    return row;
  }

  async getLatestWithDiff(
    orgId: string,
    entityType: string,
    entityId: string,
  ): Promise<SnapshotWithDiff | null> {
    const rows = await this.db
      .select()
      .from(aiSummarySnapshots)
      .where(
        and(
          eq(aiSummarySnapshots.orgId, orgId),
          eq(aiSummarySnapshots.entityType, entityType),
          eq(aiSummarySnapshots.entityId, entityId),
        ),
      )
      .orderBy(desc(aiSummarySnapshots.createdAt))
      .limit(2);

    const [current, prior] = rows;

    if (!current) return null;

    if (!prior) {
      return { snapshot: current, diff: null };
    }

    const currentStructured = current.structured ?? { highlights: [], blockers: [], nextActions: [] };
    const priorStructured = prior.structured ?? { highlights: [], blockers: [], nextActions: [] };
    const diff = computeDiff(priorStructured, currentStructured);

    return { snapshot: current, diff };
  }
}
