import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import { callAnalysisReleases } from "../../db/schema/crm/call-analysis";
import type { CallAnalysisRelease } from "./call-analysis-visibility";

/**
 * What the batched read knows about one call.
 *
 * A named type rather than an inline object because three services now destructure
 * it, and an inline shape that gains a field is a shape every one of them has to
 * be re-read to understand.
 */
export interface CallAnalysisSubjectFacts {
  readonly repUserId: string | null;
  /** Null only when the activity read did not supply one. */
  readonly occurredAt: Date | null;
  readonly release: CallAnalysisRelease | null;
}

/**
 * The rep and the release for many calls at once.
 *
 * The digest reads a cohort of analyses; resolving each one's rep with its own
 * round trip would make a manager's page cost two queries per call. Both reads
 * carry the organisation predicate, and the activity read carries the same
 * `deleted_at IS NULL` and `kind = 'call'` filters the single-row path does —
 * a batched read that quietly relaxed either would let a deleted call into an
 * aggregate that the per-call route refuses to show.
 */
export async function getSubjectsFor(
  db: Db,
  organizationId: string,
  activityIds: readonly string[],
  analyzerVersion: number,
): Promise<Map<string, CallAnalysisSubjectFacts>> {
  const out = new Map<string, CallAnalysisSubjectFacts>();
  if (activityIds.length === 0) return out;

  const ids = [...new Set(activityIds)];

  const [calls, releases] = await Promise.all([
    db
      .select({
        activityId: activities.activityId,
        actorKind: activities.actorKind,
        actorUserId: activities.actorUserId,
        /**
         * When the call happened, which is not when it was analysed. The
         * visibility rule reasons entirely from `analysed_at` and never wants
         * this — it is here for the surfaces that list calls back to a human,
         * where "analysed on Tuesday" is not what somebody is looking for.
         */
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          inArray(activities.activityId, ids),
          eq(activities.kind, "call"),
          isNull(activities.deletedAt),
        ),
      ),
    db
      .select({
        activityId: callAnalysisReleases.activityId,
        analyzerVersion: callAnalysisReleases.analyzerVersion,
        releasedAt: callAnalysisReleases.releasedAt,
      })
      .from(callAnalysisReleases)
      .where(
        and(
          eq(callAnalysisReleases.organizationId, organizationId),
          inArray(callAnalysisReleases.activityId, ids),
          eq(callAnalysisReleases.analyzerVersion, analyzerVersion),
        ),
      ),
  ]);

  const releaseByActivity = new Map<string, CallAnalysisRelease>(
    releases.map((row) => [
      row.activityId,
      { analyzerVersion: row.analyzerVersion, releasedAt: row.releasedAt },
    ]),
  );

  for (const call of calls) {
    out.set(call.activityId, {
      repUserId: call.actorKind === "human" ? call.actorUserId : null,
      occurredAt: call.occurredAt ?? null,
      release: releaseByActivity.get(call.activityId) ?? null,
    });
  }

  return out;
}
