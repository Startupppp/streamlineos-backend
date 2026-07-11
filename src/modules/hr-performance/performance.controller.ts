import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { resolvePerformanceScope } from "./performance-scope";
import { PerformanceGoalsService } from "./performance-goals.service";
import { PerformanceReviewsService } from "./performance-reviews.service";
import {
  createGoalSchema,
  createKeyResultSchema,
  createOneOnOneSchema,
  createPerformanceReviewSchema,
  createPipSchema,
  createReviewCycleSchema,
  updateGoalCollectionSchema,
  updateGoalItemSchema,
  updateKeyResultSchema,
  updateOneOnOneSchema,
  updatePerformanceReviewSchema,
  updatePipSchema,
  updateReviewCycleSchema,
  type CreateGoalInput,
  type CreateKeyResultInput,
  type CreateOneOnOneInput,
  type CreatePerformanceReviewInput,
  type CreatePipInput,
  type CreateReviewCycleInput,
  type UpdateGoalCollectionInput,
  type UpdateGoalItemInput,
  type UpdateKeyResultInput,
  type UpdateOneOnOneInput,
  type UpdatePerformanceReviewInput,
  type UpdatePipInput,
  type UpdateReviewCycleInput,
} from "./dto/performance.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/performance")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PerformanceController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly reviewsService: PerformanceReviewsService,
    private readonly access: AccessService,
  ) {}

  @Get("goals")
  @RequirePermission("hr:performance:view")
  async listGoals(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.goalsService.listGoals(u.orgId, u.userId, scope, userId);
  }

  @Post("goals")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createGoal(
    @Body(new ZodValidationPipe(createGoalSchema)) body: CreateGoalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.createGoal(u.orgId, body);
  }

  @Patch("goals")
  @RequirePermission("hr:performance:manage")
  updateGoalCollection(
    @Body(new ZodValidationPipe(updateGoalCollectionSchema)) body: UpdateGoalCollectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateGoalFromCollection(u.orgId, body);
  }

  @Patch("goals/:goalId")
  @RequirePermission("hr:performance:view")
  updateGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(updateGoalItemSchema)) body: UpdateGoalItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateGoalItem(u.orgId, goalId, body);
  }

  @Delete("goals/:goalId")
  @RequirePermission("hr:performance:manage")
  deleteGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.deleteGoal(u.orgId, goalId);
  }

  @Get("key-results")
  @RequirePermission("hr:performance:view")
  listKeyResults(
    @Query("goalId") goalId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = Number(goalId);
    if (!parsed) throw new BadRequestException("goalId is required.");
    return this.goalsService.listKeyResults(u.orgId, parsed);
  }

  @Post("key-results")
  @HttpCode(201)
  @RequirePermission("hr:performance:view")
  createKeyResult(
    @Body(new ZodValidationPipe(createKeyResultSchema)) body: CreateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.createKeyResult(u.orgId, body);
  }

  @Patch("key-results")
  @RequirePermission("hr:performance:view")
  updateKeyResult(
    @Body(new ZodValidationPipe(updateKeyResultSchema)) body: UpdateKeyResultInput,
  ) {
    return this.goalsService.updateKeyResult(body);
  }

  @Get("one-on-ones")
  @RequirePermission("hr:performance:view")
  listOneOnOnes(
    @Query("upcoming") upcoming: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.listOneOnOnes(u.orgId, u.userId, upcoming === "true");
  }

  @Post("one-on-ones")
  @HttpCode(201)
  @RequirePermission("hr:performance:view")
  createOneOnOne(
    @Body(new ZodValidationPipe(createOneOnOneSchema)) body: CreateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createOneOnOne(u.orgId, u.userId, body);
  }

  @Patch("one-on-ones/:meetingId")
  @RequirePermission("hr:performance:view")
  updateOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(updateOneOnOneSchema)) body: UpdateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateOneOnOne(u.orgId, meetingId, body);
  }

  @Delete("one-on-ones/:meetingId")
  @RequirePermission("hr:performance:view")
  deleteOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.deleteOneOnOne(u.orgId, meetingId);
  }

  @Get("pip")
  @RequirePermission("hr:performance:view")
  async listPips(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.reviewsService.listPips(u.orgId, u.userId, scope);
  }

  @Post("pip")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createPip(
    @Body(new ZodValidationPipe(createPipSchema)) body: CreatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createPip(u.orgId, u.userId, body);
  }

  @Patch("pip/:pipId")
  @RequirePermission("hr:performance:manage")
  updatePip(
    @Param("pipId", ParseIntPipe) pipId: number,
    @Body(new ZodValidationPipe(updatePipSchema)) body: UpdatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updatePip(u.orgId, pipId, body);
  }

  @Get("reviews")
  @RequirePermission("hr:performance:view")
  async listReviews(
    @Query("userId") userId: string | undefined,
    @Query("cycleId") cycleId: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.reviewsService.listReviews(u.orgId, u.userId, scope, {
      userId,
      cycleId: cycleId ? Number(cycleId) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Post("reviews")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createReview(
    @Body(new ZodValidationPipe(createPerformanceReviewSchema)) body: CreatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createReview(u.orgId, u.userId, body);
  }

  @Get("reviews/:reviewId")
  @RequirePermission("hr:performance:view")
  getReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getReview(u.orgId, reviewId);
  }

  @Delete("reviews/:reviewId")
  @RequirePermission("hr:performance:manage")
  deleteReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.deleteReview(u.orgId, reviewId);
  }

  @Patch("reviews/:reviewId")
  @RequirePermission("hr:performance:view")
  updateReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(updatePerformanceReviewSchema)) body: UpdatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateReview(u.orgId, reviewId, body);
  }

  @Get("cycles")
  @RequirePermission("hr:performance:view")
  listCycles(@CurrentUser() u: CurrentUserContext) {
    return this.reviewsService.listCycles(u.orgId);
  }

  @Post("cycles")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createCycle(
    @Body(new ZodValidationPipe(createReviewCycleSchema)) body: CreateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createCycle(u.orgId, u.userId, body);
  }

  @Get("cycles/:cycleId")
  @RequirePermission("hr:performance:view")
  getCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getCycle(u.orgId, cycleId);
  }

  @Patch("cycles/:cycleId")
  @RequirePermission("hr:performance:manage")
  updateCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(updateReviewCycleSchema)) body: UpdateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateCycle(u.orgId, cycleId, body);
  }

  @Delete("cycles/:cycleId")
  @RequirePermission("hr:performance:manage")
  deleteCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.deleteCycle(u.orgId, cycleId);
  }
}
