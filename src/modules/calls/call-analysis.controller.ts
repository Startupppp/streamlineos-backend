import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import {
  CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
  type CallAnalysisVisibility,
} from "./call-analysis-visibility";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import {
  CallAnalysisService,
  type CallAnalysis,
  type CallAnalysisOutcome,
  type CallAnalysisRefusal,
} from "./call-analysis.service";
import {
  callAnalysisParamsSchema,
  callAnalysisReleaseBodySchema,
  type CallAnalysisReleaseBody,
} from "./dto/call-analysis.schemas";

/**
 * The analysis of one call, read and produced.
 *
 * Two routes and two permissions rather than one of each, because they are
 * different authorities: reading what a call contained is a manager's job, and
 * spending the organisation's AI credits is not the same decision. A single
 * `GET` that analysed on a miss would put a paid provider call behind a page
 * load, which is how a timeline that renders twenty calls spends twenty
 * credits.
 *
 * There is no `@Idempotent` here and that is not an omission. Idempotency
 * elsewhere is a header-keyed replay window; here the transcript hash is the
 * idempotency key and it never expires, so a POST repeated tomorrow is as free
 * as one repeated in the same second.
 *
 * Both routes now answer through `CallAnalysisVisibilityService`, and the POST
 * as much as the GET. `crm:call-analysis:run` is held by every CRM admin, and
 * the analysis of an already-analysed transcript comes back from cache — so a
 * POST was, until this ticket, a way to read any rep's analysis the moment it
 * existed, straight past the read route's rule. A visibility rule that governs
 * one of two doors governs neither.
 */
@RequireModule("crm")
@Controller("crm/calls")
@UseGuards(JwtAuthGuard)
export class CallAnalysisController {
  constructor(
    private readonly analysis: CallAnalysisService,
    private readonly visibility: CallAnalysisVisibilityService,
  ) {}

  /** Never spends a credit. Absent means nobody has run it, not that it failed. */
  @Get(":activityId/analysis")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-analysis:view")
  @Validate({ params: callAnalysisParamsSchema })
  async read(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
  ) {
    const analysis = await this.analysis.find(user.orgId, activityId);
    if (!analysis)
      throw new NotFoundException("That call has not been analysed.");

    return this.withVisibility(user, activityId, analysis, true);
  }

  /**
   * Analyse it, or hand back the answer this transcript already has.
   *
   * `cached` is in the response rather than inferred from a status code: the
   * caller wants to know whether this cost anything, and 200-vs-201 would make
   * that distinction turn on whether a row happened to be created, which is not
   * the same question once two activities share one transcript.
   *
   * A manager may start an analysis of a call they will not be able to read for
   * a day, and that is intended rather than a wrinkle to be smoothed: the credit
   * is spent, the rep gets the first read, and the response says exactly when it
   * opens. Refusing the POST instead would mean a fresh call could only ever be
   * analysed by the person who made it.
   */
  @Post(":activityId/analysis")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-analysis:run")
  @HttpCode(200)
  @Validate({ params: callAnalysisParamsSchema })
  async run(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
  ) {
    const outcome = await this.analysis.analyse(user.orgId, user.userId, activityId);
    if (!outcome.ok) throw refusalToHttp(outcome);

    return this.withVisibility(user, activityId, outcome.analysis, outcome.cached);
  }

  /**
   * The rep hands their own analysis over early.
   *
   * Gated on `crm:call-analysis:view`, the key every CRM member already holds,
   * and deliberately not on a `:release` key of its own. A separate key would be
   * grantable, and therefore revocable — an administrator could take away a
   * rep's ability to share their own call, which inverts the rule this ticket
   * exists to establish. What stops one person releasing another's call is
   * `canReleaseCallAnalysis`, which compares the caller against the rep on the
   * call and answers to nobody's role.
   */
  @Post(":activityId/analysis/release")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-analysis:view")
  @HttpCode(200)
  @Validate({ params: callAnalysisParamsSchema, body: callAnalysisReleaseBodySchema })
  async release(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
    @Body() body: CallAnalysisReleaseBody,
  ) {
    /**
     * Load the analysis first, for the analyser version rather than for the
     * content. A release is consent to the judgement the rep actually read, so
     * it is pinned to that version; releasing "the analysis of this call" in the
     * abstract would carry the rep's consent forward onto whatever a later
     * prompt produces.
     */
    const analysis = await this.analysis.find(user.orgId, activityId);
    if (!analysis)
      throw new NotFoundException("That call has not been analysed, so there is nothing to share.");

    const outcome = await this.visibility.release(
      user,
      activityId,
      analysis.analyzerVersion,
      body.note ?? null,
    );

    if (!outcome.ok) {
      if (outcome.reason === "not-found") throw new NotFoundException(outcome.note);
      throw new ForbiddenException(outcome.note);
    }

    return {
      data: {
        activityId,
        analyzerVersion: analysis.analyzerVersion,
        releasedAt: outcome.releasedAt,
        alreadyReleased: outcome.alreadyReleased,
      },
    };
  }

  /**
   * One shape for both read paths, so they cannot drift.
   *
   * `data` is null rather than the route 403-ing when the rep's window is still
   * open, and the choice is deliberate. A 403 reads as "you lack the
   * permission", which is false and looks unfixable; a 404 reads as "nobody has
   * analysed this", which is also false and invites the caller to re-run.
   * Neither can carry `opensAt`, and "not yet, here is when" is the only answer
   * that describes what is actually happening. What the embargo protects is the
   * content of the analysis, not the fact that one exists — the manager can
   * already see the call on the timeline.
   */
  private async withVisibility(
    user: CurrentUserContext,
    activityId: string,
    analysis: CallAnalysis,
    cached: boolean,
  ) {
    const visibility = await this.visibility.decide(
      user,
      activityId,
      analysis.analysedAt,
      analysis.analyzerVersion,
    );

    return {
      data: visibility.visible ? analysis : null,
      cached,
      visibility: {
        visible: visibility.visible,
        reason: visibility.reason,
        opensAt: visibility.opensAt,
        privateWindowHours: CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
      } satisfies WireVisibility,
    };
  }
}

/** The visibility decision as a client sees it. Never carries the analysis. */
interface WireVisibility {
  readonly visible: boolean;
  readonly reason: CallAnalysisVisibility["reason"];
  readonly opensAt: Date | null;
  readonly privateWindowHours: number;
}

/**
 * A refusal as a status a client can act on.
 *
 * The distinction that matters is retryable versus not: `503` says the provider
 * or the credit balance is the problem and the same request will work later,
 * while `422` says this call will never be analysable and a client that keeps
 * retrying is spending nothing but noise.
 */
function refusalToHttp(outcome: Extract<CallAnalysisOutcome, { ok: false }>) {
  const byReason: Record<CallAnalysisRefusal, () => Error> = {
    "not-found": () => new NotFoundException(outcome.note),
    "not-a-call": () => new NotFoundException(outcome.note),
    "not-completed": () => new UnprocessableEntityException(outcome.note),
    "no-transcript": () => new UnprocessableEntityException(outcome.note),
    "analysis-unavailable": () => new ServiceUnavailableException(outcome.note),
  };
  return byReason[outcome.reason]();
}
