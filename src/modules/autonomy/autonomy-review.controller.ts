import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";
import type { DataScope } from "../access/access.types";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import {
  listDecisionsQuerySchema,
  reverseDecisionSchema,
  setSwitchSchema,
  type ListDecisionsQuery,
  type ReverseDecisionInput,
  type SetSwitchInput,
  scoreboardQuerySchema,
  reviewQueueQuerySchema,
  updateAutonomySettingsSchema,
  cancelHoldSchema,
  type ScoreboardQuery,
  type ReviewQueueQuery,
  type UpdateAutonomySettingsInput,
  type CancelHoldInput,
} from "./dto/autonomy-review.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const decisionIdParams = z.object({ decisionId: z.string().min(1) }).strict();
const shadowScoreIdParams = z.object({ shadowScoreId: z.string().min(1) }).strict();
const holdIdParams = z.object({ holdId: z.string().min(1) }).strict();

const REVIEW_PERMISSION = "crm:autonomy:view";

@Controller("crm/autonomy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AutonomyReviewController {
  constructor(
    private readonly svc: AutonomyReviewService,
    private readonly scoring: AutonomyScoringService,
    private readonly holds: AutonomyHoldService,
    private readonly access: AccessService,
  ) {}

  @Get("decisions")
  @RequirePermission(REVIEW_PERMISSION)
  @Validate({ query: listDecisionsQuerySchema })
  async listDecisions(
    @Query() query: ListDecisionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDecisions(u.orgId, u.userId, query, await this.readScope(u));
  }

  @Get("decisions/:decisionId")
  @RequirePermission(REVIEW_PERMISSION)
  @Validate({ params: decisionIdParams })
  getDecision(
    @Param("decisionId") decisionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getDecision(u.orgId, decisionId);
  }

  /**
   * Undo one. Separate from `crm:autonomy:view` because reading the feed and
   * changing records are different authorities — a reviewer who may audit
   * everything is not necessarily one who may reach into a rep's pipeline.
   */
  @Post("decisions/:decisionId/reverse")
  @Idempotent("crm.autonomy.reverse")
  @RequirePermission("crm:autonomy:reverse")
  @Validate({ params: decisionIdParams, body: reverseDecisionSchema })
  reverseDecision(
    @Param("decisionId") decisionId: string,
    @Body() body: ReverseDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reverseDecision(u.orgId, u.userId, decisionId, body);
  }

  @Get("switches")
  @RequirePermission(REVIEW_PERMISSION)
  listSwitches(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listSwitches(u.orgId);
  }

  @Patch("switches")
  @Idempotent("crm.autonomy.switch")
  @RequirePermission("crm:autonomy:manage")
  @Validate({ body: setSwitchSchema })
  setSwitch(
    @Body() body: SetSwitchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setSwitch(u.orgId, u.userId, body);
  }

  /**
   * How often the system is right, per action type, as numbers that move.
   *
   * Not gated behind the manage key: an evidence-based decision about whether to
   * enable an action type is exactly what a reader of the feed is trying to
   * make, and hiding the evidence behind the control would invert that.
   */
  @Get("scoreboard")
  @RequirePermission(REVIEW_PERMISSION)
  @Validate({ query: scoreboardQuerySchema })
  scoreboard(
    @Query() query: ScoreboardQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.scoreboard(u.orgId, query.days);
  }

  /** What a second pass disagreed with and nobody has looked at yet. */
  @Get("review-queue")
  @RequirePermission(REVIEW_PERMISSION)
  @Validate({ query: reviewQueueQuerySchema })
  reviewQueue(
    @Query() query: ReviewQueueQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.reviewQueue(u.orgId, query.limit);
  }

  @Post("review-queue/:shadowScoreId/reviewed")
  @BodylessAction()
  @Idempotent("crm.autonomy.reviewed")
  @RequirePermission(REVIEW_PERMISSION)
  @Validate({ params: shadowScoreIdParams })
  markReviewed(
    @Param("shadowScoreId") shadowScoreId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.markReviewed(u.orgId, u.userId, shadowScoreId);
  }

  /**
   * What is about to leave the building, and how long is left.
   *
   * Behind the view key rather than the cancel key: seeing that something is
   * about to send is exactly what makes a person decide to stop it, and hiding
   * it from everyone who cannot cancel would shrink the audience the window
   * exists for.
   */
  @Get("holds")
  @RequirePermission(REVIEW_PERMISSION)
  liveHolds(@CurrentUser() u: CurrentUserContext) {
    return this.holds.liveHolds(u.orgId);
  }

  /** Stop one before it leaves. Nobody ever approves; they only cancel. */
  @Post("holds/:holdId/cancel")
  @Idempotent("crm.autonomy.cancel-hold")
  @RequirePermission("crm:autonomy:reverse")
  @Validate({ params: holdIdParams, body: cancelHoldSchema })
  cancelHold(
    @Param("holdId") holdId: string,
    @Body() body: CancelHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.holds.cancelHold(u.orgId, u.userId, holdId, body.reason);
  }

  @Get("settings")
  @RequirePermission(REVIEW_PERMISSION)
  settings(@CurrentUser() u: CurrentUserContext) {
    return this.scoring.settingsFor(u.orgId);
  }

  /** Sampling rate, its daily cap, and the hold window. */
  @Patch("settings")
  @Idempotent("crm.autonomy.settings")
  @RequirePermission("crm:autonomy:manage")
  @Validate({ body: updateAutonomySettingsSchema })
  updateSettings(
    @Body() body: UpdateAutonomySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.updateSettings(u.orgId, body);
  }

  /**
   * The same narrowing the deals list applies, resolved from the review key.
   *
   * A rep restricted to their own deals must not see, in the feed, the actions
   * the system took on everybody else's.
   */
  private async readScope(u: CurrentUserContext): Promise<DataScope> {
    if (u.isOrgOwner) return "all";
    if (!isScopable(REVIEW_PERMISSION)) return "all";
    const resolved = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return resolved.get(REVIEW_PERMISSION) ?? "none";
  }
}
