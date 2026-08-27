import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import { callAnalysisReleases } from "../../db/schema/crm/call-analysis";
import { AccessService } from "../access/access.service";
import {
  callAnalysisVisibility,
  canReleaseCallAnalysis,
  type CallAnalysisRelease,
  type CallAnalysisSubject,
  type CallAnalysisViewer,
  type CallAnalysisVisibility,
} from "./call-analysis-visibility";

/**
 * The facts the visibility rule needs, fetched once and fed to the pure rule.
 *
 * Everything that talks to the database about who may read a call analysis is
 * here, and everything that *decides* is in `call-analysis-visibility.ts`. The
 * split is what keeps the rule assertable at the millisecond and keeps this file
 * from growing a second, subtly different copy of it — which is how the CRM
 * ended up with five ways to record a call.
 *
 * Two joins matter and both carry the organisation predicate on every side.
 * `crm_call_analyses.activity_id` is not a foreign key (deliberately — see the
 * schema), so nothing may assume the activity is still there; a call that has
 * been deleted from the timeline resolves to no rep, and the caller is told the
 * analysis is unreadable rather than shown it with an empty attribution.
 */

/** The permission that lets somebody read a call they were not on. */
export const CALL_ANALYSIS_VIEW_TEAM = "crm:call-analysis:view-team";

export type CallAnalysisReleaseOutcome =
  | {
      readonly ok: true;
      readonly releasedAt: Date;
      /** True when the rep had already released it; the first decision stands. */
      readonly alreadyReleased: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "not-your-call";
      readonly note: string;
    };

@Injectable()
export class CallAnalysisVisibilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * Whether this user may read this call's analysis right now.
   *
   * `analyzerVersion` is the version of the row actually being read, passed in
   * rather than taken from the constant, so that a release made against an older
   * analyser is not silently credited to a newer one.
   */
  async decide(
    user: CurrentUserContext,
    activityId: string,
    analysedAt: Date,
    analyzerVersion: number,
  ): Promise<CallAnalysisVisibility> {
    const viewer = await this.viewer(user);
    const subject = await this.subject(user.orgId, activityId, analysedAt, analyzerVersion);
    return callAnalysisVisibility(viewer, subject, new Date());
  }

  /**
   * The rep hands their analysis to their manager before the window is up.
   *
   * Idempotent by the unique index rather than by a read-then-write: two taps on
   * "share" a second apart would otherwise both see no row and both insert, and
   * the rule would then have to pick a `released_at` from two, which is a
   * question with no correct answer.
   */
  async release(
    user: CurrentUserContext,
    activityId: string,
    analyzerVersion: number,
    note: string | null,
  ): Promise<CallAnalysisReleaseOutcome> {
    const repUserId = await this.repFor(user.orgId, activityId);
    if (repUserId === undefined) {
      return {
        ok: false,
        reason: "not-found",
        note: "That call is not on this organisation's timeline.",
      };
    }

    if (!canReleaseCallAnalysis({ userId: user.userId, canReadTeam: false }, { repUserId })) {
      /**
       * The same refusal whether the caller is a manager, an org owner, or a rep
       * looking at somebody else's call. A release is the one decision in this
       * design that belongs to one person; an override here would make the
       * private window a delay a manager can skip, which is the same as not
       * having one.
       */
      return {
        ok: false,
        reason: "not-your-call",
        note: "Only the person who was on the call can share its analysis.",
      };
    }

    /**
     * Read before writing only to answer `alreadyReleased`, which is a message
     * to a human ("shared yesterday") and not a decision anything depends on.
     * Two simultaneous taps can both read nothing and both report a fresh
     * release; the unique index still leaves exactly one row and one
     * `released_at`, so the visibility rule is unaffected either way. Deciding
     * anything real on this read would be a check-then-act race.
     */
    const before = await this.releaseFor(user.orgId, activityId, analyzerVersion);

    await this.db
      .insert(callAnalysisReleases)
      .values({
        organizationId: user.orgId,
        activityId,
        analyzerVersion,
        releasedByUserId: user.userId,
        note,
      })
      /**
       * The first release stands. Overwriting would move `released_at` forward
       * every time the rep opened the sharing control, which for a manager who
       * had already read it would look like the analysis was shared later than
       * it was — and would push the row back behind the window in any surface
       * that reasons from that timestamp.
       */
      .onConflictDoNothing();

    const existing = await this.releaseFor(user.orgId, activityId, analyzerVersion);
    if (!existing) {
      // The insert reported no error and the read came back empty. Reporting
      // success here would tell a rep their call was shared when nothing
      // recorded it, so this fails loudly instead.
      throw new Error(`call analysis release for ${activityId} was not recorded`);
    }

    return {
      ok: true,
      releasedAt: existing.releasedAt,
      alreadyReleased: before !== null,
    };
  }

  /** Whether this user holds the key that lets them read other people's calls. */
  async viewer(user: CurrentUserContext): Promise<CallAnalysisViewer> {
    return {
      userId: user.userId,
      canReadTeam: await this.access.holds(user, CALL_ANALYSIS_VIEW_TEAM),
    };
  }

  /** The rep on a call, `null` when nobody is attributed, `undefined` when there is no such call. */
  async repFor(organizationId: string, activityId: string): Promise<string | null | undefined> {
    const [row] = await this.db
      .select({
        actorKind: activities.actorKind,
        actorUserId: activities.actorUserId,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          eq(activities.kind, "call"),
          isNull(activities.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return undefined;
    // `actor_kind = 'system'` is every adapter-delivered call, and those carry
    // no user at all. Reading `actorUserId` without the kind check would treat a
    // stray value on a system row as a person to protect.
    return row.actorKind === "human" ? row.actorUserId : null;
  }

  private async subject(
    organizationId: string,
    activityId: string,
    analysedAt: Date,
    analyzerVersion: number,
  ): Promise<CallAnalysisSubject> {
    const [repUserId, release] = await Promise.all([
      this.repFor(organizationId, activityId),
      this.releaseFor(organizationId, activityId, analyzerVersion),
    ]);

    return {
      // A deleted or missing call has no rep to protect and no rep to release
      // it; it resolves the same way an unattributed one does.
      repUserId: repUserId ?? null,
      analysedAt,
      analyzerVersion,
      release: release
        ? { analyzerVersion: release.analyzerVersion, releasedAt: release.releasedAt }
        : null,
    };
  }

  private async releaseFor(
    organizationId: string,
    activityId: string,
    analyzerVersion: number,
  ): Promise<typeof callAnalysisReleases.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(callAnalysisReleases)
      .where(
        and(
          eq(callAnalysisReleases.organizationId, organizationId),
          eq(callAnalysisReleases.activityId, activityId),
          eq(callAnalysisReleases.analyzerVersion, analyzerVersion),
        ),
      )
      .limit(1);

    return row ?? null;
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
  async subjectsFor(
    organizationId: string,
    activityIds: readonly string[],
    analyzerVersion: number,
  ): Promise<Map<string, { repUserId: string | null; release: CallAnalysisRelease | null }>> {
    const out = new Map<string, { repUserId: string | null; release: CallAnalysisRelease | null }>();
    if (activityIds.length === 0) return out;

    const ids = [...new Set(activityIds)];

    const [calls, releases] = await Promise.all([
      this.db
        .select({
          activityId: activities.activityId,
          actorKind: activities.actorKind,
          actorUserId: activities.actorUserId,
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
      this.db
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
        release: releaseByActivity.get(call.activityId) ?? null,
      });
    }

    return out;
  }
}
