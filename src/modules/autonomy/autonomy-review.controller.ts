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
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyRepairService } from "./autonomy-repair.service";
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
  runRepairsSchema,
  setRepairPolicySchema,
  listRepairsQuerySchema,
  revertRepairSchema,
  repairMeasureQuerySchema,
  type RunRepairsInput,
  type SetRepairPolicyInput,
  type ListRepairsQuery,
  type RevertRepairInput,
  type RepairMeasureQuery,
} from "./dto/autonomy-review.schemas";

const REVIEW_PERMISSION = "crm:autonomy:view";
/** Deciding what the system may change unattended, which is not the kill switch. */

@Controller("crm/autonomy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AutonomyReviewController {
  constructor(
    private readonly svc: AutonomyReviewService,
    private readonly scoring: AutonomyScoringService,
    private readonly holds: AutonomyHoldService,
    private readonly repairs: AutonomyRepairService,
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

  /**
   * Undo one. Separate from `crm:autonomy:view` because reading the feed and
   * changing records are different authorities — a reviewer who may audit
   * everything is not necessarily one who may reach into a rep's pipeline.
   */
  @Post("decisions/:decisionId/reverse")
  @Idempotent("crm.autonomy.reverse")
  @RequirePermission("crm:autonomy:reverse")
  reverseDecision(
    @Param("decisionId") decisionId: string,
    @Body(new ZodValidationPipe(reverseDecisionSchema)) body: ReverseDecisionInput,
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
  setSwitch(
    @Body(new ZodValidationPipe(setSwitchSchema)) body: SetSwitchInput,
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
  scoreboard(
    @Query(new ZodValidationPipe(scoreboardQuerySchema)) query: ScoreboardQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.scoreboard(u.orgId, query.days);
  }

  /** What a second pass disagreed with and nobody has looked at yet. */
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

  /** Sampling rate, its daily cap, and the hold window. */
  @Patch("settings")
  @Idempotent("crm.autonomy.settings")
  @RequirePermission("crm:autonomy:manage")
  updateSettings(
    @Body(new ZodValidationPipe(updateAutonomySettingsSchema)) body: UpdateAutonomySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scoring.updateSettings(u.orgId, body);
  }

  // ── Unattended repair ─────────────────────────────────────────────────────

  /**
   * Which classes this organisation lets the system repair without asking.
   *
   * Behind the view key. A reader of the feed asking "why was that not fixed"
   * needs the answer, and it is the same evidence they would use to decide
   * whether to grant the class — hiding it behind the ability to change it would
   * invert the decision it informs.
   */
  @Get("repair-policies")
  @RequirePermission(REVIEW_PERMISSION)
  repairPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.repairs.policiesFor(u.orgId);
  }

  /**
   * Grant or withhold one class.
   *
   * Its own key rather than `crm:autonomy:manage`: that one governs whether an
   * action type runs at all, and this governs whether the system may change
   * stored customer data unattended. They are different authorities, and folding
   * the second into the first would make it impossible to give somebody the
   * kill switch without also giving them this.
   */
  @Patch("repair-policies")
  @Idempotent("crm.autonomy.repair-policy")
  @RequirePermission("crm:autonomy:repair")
  setRepairPolicy(
    @Body(new ZodValidationPipe(setRepairPolicySchema)) body: SetRepairPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.repairs.setPolicy(u.orgId, u.userId, body);
  }

  /** Run the loop now. Every class is still asked separately whether it may. */
  @Post("repairs/run")
  @Idempotent("crm.autonomy.repair-run")
  @RequirePermission("crm:autonomy:repair")
  runRepairs(
    @Body(new ZodValidationPipe(runRepairsSchema)) body: RunRepairsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.repairs.runRepairs(u.orgId, body);
  }

  /** Every value the system rewrote, newest first. */
  @Get("repairs")
  @RequirePermission(REVIEW_PERMISSION)
  listRepairs(
    @Query(new ZodValidationPipe(listRepairsQuerySchema)) query: ListRepairsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.repairs.listRepairs(u.orgId, query);
  }

  /**
   * Put one value back, without touching the rest of its batch.
   *
   * Same key as reversing any other autonomous action, because it is one: a
   * reviewer who may undo a stage change may undo a repair. The batch-wide undo
   * is the ordinary `decisions/:decisionId/reverse` above.
   */
  @Post("repairs/:repairId/revert")
  @Idempotent("crm.autonomy.repair-revert")
  @RequirePermission("crm:autonomy:reverse")
  revertRepair(
    @Param("repairId") repairId: string,
    @Body(new ZodValidationPipe(revertRepairSchema)) body: RevertRepairInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.repairs.revertOne(u.orgId, u.userId, repairId, body.reason ?? null);
  }

  /**
   * How much of the queue the system cleared, against how much a person did,
   * and what is left.
   */
  @Get("repair-measure")
  @RequirePermission(REVIEW_PERMISSION)
  repairMeasure(
    @Query(new ZodValidationPipe(repairMeasureQuerySchema)) query: RepairMeasureQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.repairs.measure(u.orgId, query.days);
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
