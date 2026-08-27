import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmCallAnalyses } from "../../../db/schema/crm/call-analysis";
import {
  coachingPrompts,
  repTrend,
  teamCoachingView,
  type AnalysedCall,
  type CoachingPrompt,
  type RepTrendPoint,
  type TeamCoachingView,
} from "../coaching";
import { visibilityDisclosure, type VisibilityDisclosure } from "../visibility";

/**
 * The two surfaces, and neither of them can cause an analysis.
 *
 * This service reads `crm_call_analyses` and nothing else. It holds no reference
 * to the analyser, its module does not import the analyser's module, and there
 * is no argument anywhere in this file that could mean "produce one if it is
 * missing" — a call that has never been analysed is simply not in the result.
 *
 * That is ticket 01's third criterion, and it is built the way
 * `query-compiler.ts` builds tenancy: not by rejecting the request but by there
 * being nowhere to write it down. `read-cannot-analyse.spec.ts` holds both
 * halves of that claim to the wall.
 */
@Injectable()
export class CallAnalysisReadService {
  /** The window both surfaces read. A quarter is what a coaching conversation covers. */
  private static readonly DEFAULT_WINDOW_DAYS = 90;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A rep's own calls, their own trend, and what their manager can see.
   *
   * The disclosure travels with the data rather than living on a settings page,
   * which is ticket 02's third criterion: a promise about visibility that a
   * person has to go looking for is a promise most people never read.
   */
  async forRep(
    organizationId: string,
    userId: string,
    windowDays = CallAnalysisReadService.DEFAULT_WINDOW_DAYS,
  ): Promise<{
    calls: AnalysedCall[];
    trend: RepTrendPoint[];
    prompts: CoachingPrompt[];
    visibility: VisibilityDisclosure;
  }> {
    const calls = await this.load(
      organizationId,
      windowDays,
      eq(crmCallAnalyses.repUserId, userId),
    );

    return {
      calls,
      trend: repTrend(calls),
      // The same function the team view uses, so a rep and their manager are
      // never told different things about the same calls.
      prompts: coachingPrompts(calls),
      visibility: visibilityDisclosure(),
    };
  }

  /**
   * The team, pooled.
   *
   * `teamCoachingView` returns a type with no call identifier and no person on
   * it, so what this method can leak is bounded by the shape rather than by the
   * query being written carefully. The per-call rows are loaded and reduced;
   * they do not survive the reduction.
   */
  async forManager(
    organizationId: string,
    windowDays = CallAnalysisReadService.DEFAULT_WINDOW_DAYS,
  ): Promise<TeamCoachingView> {
    return teamCoachingView(await this.load(organizationId, windowDays));
  }

  private async load(
    organizationId: string,
    windowDays: number,
    extra?: SQL,
  ): Promise<AnalysedCall[]> {
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const rows = await this.db
      .select({
        crmCallAnalysisId: crmCallAnalyses.crmCallAnalysisId,
        activityId: crmCallAnalyses.activityId,
        repUserId: crmCallAnalyses.repUserId,
        occurredAt: crmCallAnalyses.occurredAt,
        talkRatioBps: crmCallAnalyses.talkRatioBps,
        questionShareBps: crmCallAnalyses.questionShareBps,
        objections: crmCallAnalyses.objections,
        competitorKeys: crmCallAnalyses.competitorKeys,
        nextStepCommitted: crmCallAnalyses.nextStepCommitted,
      })
      .from(crmCallAnalyses)
      .where(
        and(
          eq(crmCallAnalyses.organizationId, organizationId),
          gte(crmCallAnalyses.occurredAt, since),
          ...(extra ? [extra] : []),
        ),
      )
      .orderBy(desc(crmCallAnalyses.occurredAt));

    return rows;
  }
}
