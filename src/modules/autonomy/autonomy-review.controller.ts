import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";
import type { DataScope } from "../access/access.types";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyReversalService } from "./autonomy-reversal.service";
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

const REVIEW_PERMISSION = "crm:autonomy:view";

@Controller("crm/autonomy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AutonomyReviewController {
  constructor(
    private readonly svc: AutonomyReviewService,
    private readonly reversal: AutonomyReversalService,
    private readonly scoring: AutonomyScoringService,
    private readonly holds: AutonomyHoldService,
    private readonly access: AccessService,
  ) {}

  @Get("decisions")
  @RequirePermission(REVIEW_PERMISSION)
  async listDecisions(
    @Query(new ZodValidationPipe(listDecisionsQuerySchema)) query: ListDecisionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDecisions(u.orgId, u.userId, query, await this.readScope(u));
  }

  @Get("decisions/:decisionId")
  @RequirePermission(REVIEW_PERMISSION)
  getDecision(
    @Param("decisionId") decisionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getDecision(u.orgId, decisionId);
  }

  @Post("decisions/:decisionId/reverse")
  @Idempotent("crm.autonomy.reverse")
  @RequirePermission("crm:autonomy:reverse")
  reverseDecision(
    @Param("decisionId") decisionId: string,
    @Body(new ZodValidationPipe(reverseDecisionSchema)) body: ReverseDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reversal.reverseDecision(u.orgId, u.userId, decisionId, body);
  }

  @Get("switches")
  @RequirePermission(REVIEW_PERMISSION)
  listSwitches(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listSwitches(u.orgId);
  }

  @Patch("switches")
  @Idempotent("crm.autonomy.switch")
  @RequirePermission("crm:autonomy:manage")
  setSwitch(
    @Body(new ZodValidationPipe(setSwitchSchema)) body: SetSwitchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setSwitch(u.orgId, u.userId, body);
  }

  @Get("scoreboard")
  @RequirePermission(REVIEW_PERMISSION)
  scoreboard(
    @Query(new ZodValidationPipe(scoreboardQuerySchema)) query: ScoreboardQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.scoreboard(u.orgId, query.days);
  }

  @Get("review-queue")
  @RequirePermission(REVIEW_PERMISSION)
  reviewQueue(
    @Query(new ZodValidationPipe(reviewQueueQuerySchema)) query: ReviewQueueQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.reviewQueue(u.orgId, query.limit);
  }

  @Post("review-queue/:shadowScoreId/reviewed")
  @Idempotent("crm.autonomy.reviewed")
  @RequirePermission(REVIEW_PERMISSION)
  markReviewed(
    @Param("shadowScoreId") shadowScoreId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.markReviewed(u.orgId, u.userId, shadowScoreId);
  }

  @Get("holds")
  @RequirePermission(REVIEW_PERMISSION)
  liveHolds(@CurrentUser() u: CurrentUserContext) {
    return this.holds.liveHolds(u.orgId);
  }

  @Post("holds/:holdId/cancel")
  @Idempotent("crm.autonomy.cancel-hold")
  @RequirePermission("crm:autonomy:reverse")
  cancelHold(
    @Param("holdId") holdId: string,
    @Body(new ZodValidationPipe(cancelHoldSchema)) body: CancelHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.holds.cancelHold(u.orgId, u.userId, holdId, body.reason);
  }

  @Get("settings")
  @RequirePermission(REVIEW_PERMISSION)
  settings(@CurrentUser() u: CurrentUserContext) {
    return this.scoring.settingsFor(u.orgId);
  }

  @Patch("settings")
  @Idempotent("crm.autonomy.settings")
  @RequirePermission("crm:autonomy:manage")
  updateSettings(
    @Body(new ZodValidationPipe(updateAutonomySettingsSchema)) body: UpdateAutonomySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.updateSettings(u.orgId, body);
  }

  private async readScope(u: CurrentUserContext): Promise<DataScope> {
    if (u.isOrgOwner) return "all";
    if (!isScopable(REVIEW_PERMISSION)) return "all";
    const resolved = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return resolved.get(REVIEW_PERMISSION) ?? "none";
  }
}
