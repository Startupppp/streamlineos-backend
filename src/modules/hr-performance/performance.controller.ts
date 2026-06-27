import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { canManagePerformance } from "./ability.helpers";
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

@Controller("hr/performance")
@UseGuards(JwtAuthGuard)
export class PerformanceController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly reviewsService: PerformanceReviewsService,
  ) {}

  @Get("goals")
  listGoals(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    const isAdmin = canManagePerformance(u);
    if (userId && userId !== u.userId && !isAdmin) {
      throw new ForbiddenException("Not authorized.");
    }
    return this.goalsService.listGoals(u.orgId, u.userId, isAdmin, userId);
  }

  @Post("goals")
  @HttpCode(200)
  createGoal(
    @Body(new ZodValidationPipe(createGoalSchema)) body: CreateGoalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Only admins can create goals.");
    return this.goalsService.createGoal(u.orgId, body);
  }

  @Patch("goals")
  @HttpCode(201)
  updateGoalCollection(
    @Body(new ZodValidationPipe(updateGoalCollectionSchema)) body: UpdateGoalCollectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Only admins can update goals.");
    return this.goalsService.updateGoalFromCollection(u.orgId, body);
  }

  @Patch("goals/:goalId")
  updateGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(updateGoalItemSchema)) body: UpdateGoalItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateGoalItem(u.orgId, goalId, body);
  }

  @Delete("goals/:goalId")
  deleteGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.deleteGoal(u.orgId, goalId);
  }

  @Get("key-results")
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
  createKeyResult(
    @Body(new ZodValidationPipe(createKeyResultSchema)) body: CreateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.createKeyResult(u.orgId, body);
  }

  @Patch("key-results")
  updateKeyResult(
    @Body(new ZodValidationPipe(updateKeyResultSchema)) body: UpdateKeyResultInput,
  ) {
    return this.goalsService.updateKeyResult(body);
  }

  @Get("one-on-ones")
  listOneOnOnes(
    @Query("upcoming") upcoming: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.listOneOnOnes(u.orgId, u.userId, upcoming === "true");
  }

  @Post("one-on-ones")
  @HttpCode(201)
  createOneOnOne(
    @Body(new ZodValidationPipe(createOneOnOneSchema)) body: CreateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createOneOnOne(u.orgId, u.userId, body);
  }

  @Patch("one-on-ones/:meetingId")
  updateOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(updateOneOnOneSchema)) body: UpdateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateOneOnOne(u.orgId, meetingId, body);
  }

  @Delete("one-on-ones/:meetingId")
  deleteOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.deleteOneOnOne(u.orgId, meetingId);
  }

  @Get("pip")
  listPips(@CurrentUser() u: CurrentUserContext) {
    return this.reviewsService.listPips(u.orgId, u.userId, canManagePerformance(u));
  }

  @Post("pip")
  @HttpCode(201)
  createPip(
    @Body(new ZodValidationPipe(createPipSchema)) body: CreatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Only admins can create PIPs.");
    return this.reviewsService.createPip(u.orgId, u.userId, body);
  }

  @Patch("pip/:pipId")
  updatePip(
    @Param("pipId", ParseIntPipe) pipId: number,
    @Body(new ZodValidationPipe(updatePipSchema)) body: UpdatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Forbidden.");
    return this.reviewsService.updatePip(u.orgId, pipId, body);
  }

  @Post("reviews")
  @HttpCode(201)
  createReview(
    @Body(new ZodValidationPipe(createPerformanceReviewSchema)) body: CreatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Only admins can create reviews.");
    return this.reviewsService.createReview(u.orgId, u.userId, body);
  }

  @Get("reviews/:reviewId")
  getReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getReview(u.orgId, reviewId);
  }

  @Delete("reviews/:reviewId")
  deleteReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.deleteReview(u.orgId, reviewId);
  }

  @Patch("reviews/:reviewId")
  updateReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(updatePerformanceReviewSchema)) body: UpdatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateReview(u.orgId, reviewId, body);
  }

  @Post("cycles")
  @HttpCode(201)
  createCycle(
    @Body(new ZodValidationPipe(createReviewCycleSchema)) body: CreateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Only admins can create review cycles.");
    return this.reviewsService.createCycle(u.orgId, u.userId, body);
  }

  @Get("cycles/:cycleId")
  getCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getCycle(u.orgId, cycleId);
  }

  @Patch("cycles/:cycleId")
  updateCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(updateReviewCycleSchema)) body: UpdateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Forbidden.");
    return this.reviewsService.updateCycle(u.orgId, cycleId, body);
  }

  @Delete("cycles/:cycleId")
  deleteCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Forbidden.");
    return this.reviewsService.deleteCycle(u.orgId, cycleId);
  }
}
