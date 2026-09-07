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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { AccessService } from "../../access/access.service";
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
  listPerformanceReviewsSchema,
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
  type ListPerformanceReviewsInput,
  type UpdateGoalCollectionInput,
  type UpdateGoalItemInput,
  type UpdateKeyResultInput,
  type UpdateOneOnOneInput,
  type UpdatePerformanceReviewInput,
  type UpdatePipInput,
  type UpdateReviewCycleInput,
} from "./dto/performance.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { listGoalsResponseSchema, createGoalResponseSchema, updateGoalResponseSchema, listKeyResultsResponseSchema, createKeyResultResponseSchema, updateKeyResultResponseSchema, listOneOnOnesResponseSchema, createOneOnOneResponseSchema, updateOneOnOneResponseSchema, listPipsResponseSchema, createPipResponseSchema, updatePipResponseSchema, listReviewsResponseSchema, createReviewResponseSchema, getReviewResponseSchema, updateReviewResponseSchema, listCyclesResponseSchema, createCycleResponseSchema, getCycleResponseSchema, updateCycleResponseSchema } from "./dto/performance-response.schemas"

const goalIdParams = z.object({ goalId: z.coerce.number().int().positive() }).strict();
const meetingIdParams = z.object({ meetingId: z.coerce.number().int().positive() }).strict();
const pipIdParams = z.object({ pipId: z.coerce.number().int().positive() }).strict();
const reviewIdParams = z.object({ reviewId: z.coerce.number().int().positive() }).strict();
const cycleIdParams = z.object({ cycleId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/performance")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PerformanceController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly reviewsService: PerformanceReviewsService,
    private readonly access: AccessService,
  ) {}

  @ResponseSchema(listGoalsResponseSchema)
  @Get("goals")
  @RequirePermission("hr:performance:view")
  async listGoals(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.goalsService.listGoals(u.orgId, u.userId, scope, userId);
  }

  @ResponseSchema(createGoalResponseSchema)
  @Post("goals")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createGoalSchema })
  createGoal(
    @Body() body: CreateGoalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.createGoal(u.orgId, body);
  }

  @ResponseSchema(updateGoalResponseSchema)
  @Patch("goals")
  @RequirePermission("hr:performance:manage")
  @Validate({ body: updateGoalCollectionSchema })
  updateGoalCollection(
    @Body() body: UpdateGoalCollectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateGoalFromCollection(u.orgId, body);
  }

  @ResponseSchema(updateGoalResponseSchema)
  @Patch("goals/:goalId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: goalIdParams, body: updateGoalItemSchema })
  async updateGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body() body: UpdateGoalItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateGoalItem(u.orgId, u.userId, await this.canManagePerformance(u), goalId, body);
  }

  @NoContentResponse()
  @Delete("goals/:goalId")
  @HttpCode(204)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: goalIdParams })
  async deleteGoal(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.goalsService.deleteGoal(u.orgId, goalId);
  }

  @ResponseSchema(listKeyResultsResponseSchema)
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

  @ResponseSchema(createKeyResultResponseSchema)
  @Post("key-results")
  @HttpCode(201)
  @RequirePermission("hr:performance:view")
  @Validate({ body: createKeyResultSchema })
  async createKeyResult(
    @Body() body: CreateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.createKeyResult(u.orgId, u.userId, await this.canManagePerformance(u), body);
  }

  @ResponseSchema(updateKeyResultResponseSchema)
  @Patch("key-results")
  @RequirePermission("hr:performance:manage")
  @Validate({ body: updateKeyResultSchema })
  updateKeyResult(
    @Body() body: UpdateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goalsService.updateKeyResult(u.orgId, body);
  }

  @ResponseSchema(listOneOnOnesResponseSchema)
  @Get("one-on-ones")
  @RequirePermission("hr:performance:view")
  listOneOnOnes(
    @Query("upcoming") upcoming: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.listOneOnOnes(u.orgId, u.userId, upcoming === "true");
  }

  @ResponseSchema(createOneOnOneResponseSchema)
  @Post("one-on-ones")
  @HttpCode(201)
  @RequirePermission("hr:performance:view")
  @Validate({ body: createOneOnOneSchema })
  createOneOnOne(
    @Body() body: CreateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createOneOnOne(u.orgId, u.userId, body);
  }

  @ResponseSchema(updateOneOnOneResponseSchema)
  @Patch("one-on-ones/:meetingId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: meetingIdParams, body: updateOneOnOneSchema })
  async updateOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: UpdateOneOnOneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateOneOnOne(u.orgId, u.userId, await this.canManagePerformance(u), meetingId, body);
  }

  @NoContentResponse()
  @Delete("one-on-ones/:meetingId")
  @HttpCode(204)
  @RequirePermission("hr:performance:view")
  @Validate({ params: meetingIdParams })
  async deleteOneOnOne(
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reviewsService.deleteOneOnOne(u.orgId, u.userId, await this.canManagePerformance(u), meetingId);
  }

  @ResponseSchema(listPipsResponseSchema)
  @Get("pip")
  @RequirePermission("hr:performance:view")
  async listPips(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.reviewsService.listPips(u.orgId, u.userId, scope);
  }

  @ResponseSchema(createPipResponseSchema)
  @Post("pip")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createPipSchema })
  createPip(
    @Body() body: CreatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createPip(u.orgId, u.userId, body);
  }

  @ResponseSchema(updatePipResponseSchema)
  @Patch("pip/:pipId")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: pipIdParams, body: updatePipSchema })
  updatePip(
    @Param("pipId", ParseIntPipe) pipId: number,
    @Body() body: UpdatePipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updatePip(u.orgId, pipId, body);
  }

  @ResponseSchema(listReviewsResponseSchema)
  @Get("reviews")
  @RequirePermission("hr:performance:view")
  @Validate({ query: listPerformanceReviewsSchema })
  async listReviews(
    @Query() query: ListPerformanceReviewsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePerformanceScope(this.access, u);
    return this.reviewsService.listReviews(u.orgId, u.userId, scope, query);
  }

  @ResponseSchema(createReviewResponseSchema)
  @Post("reviews")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createPerformanceReviewSchema })
  createReview(
    @Body() body: CreatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createReview(u.orgId, u.userId, body);
  }

  @ResponseSchema(getReviewResponseSchema)
  @Get("reviews/:reviewId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: reviewIdParams })
  getReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getReview(u.orgId, reviewId);
  }

  @NoContentResponse()
  @Delete("reviews/:reviewId")
  @HttpCode(204)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: reviewIdParams })
  async deleteReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reviewsService.deleteReview(u.orgId, reviewId);
  }

  @ResponseSchema(updateReviewResponseSchema)
  @Patch("reviews/:reviewId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: reviewIdParams, body: updatePerformanceReviewSchema })
  async updateReview(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body() body: UpdatePerformanceReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateReview(u.orgId, u.userId, await this.canManagePerformance(u), reviewId, body);
  }

  @ResponseSchema(listCyclesResponseSchema)
  @Get("cycles")
  @RequirePermission("hr:performance:view")
  listCycles(@CurrentUser() u: CurrentUserContext) {
    return this.reviewsService.listCycles(u.orgId);
  }

  @ResponseSchema(createCycleResponseSchema)
  @Post("cycles")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createReviewCycleSchema })
  createCycle(
    @Body() body: CreateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.createCycle(u.orgId, u.userId, body);
  }

  @ResponseSchema(getCycleResponseSchema)
  @Get("cycles/:cycleId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: cycleIdParams })
  getCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.getCycle(u.orgId, cycleId);
  }

  @ResponseSchema(updateCycleResponseSchema)
  @Patch("cycles/:cycleId")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: cycleIdParams, body: updateReviewCycleSchema })
  updateCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body() body: UpdateReviewCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reviewsService.updateCycle(u.orgId, cycleId, body);
  }

  @NoContentResponse()
  @Delete("cycles/:cycleId")
  @HttpCode(204)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: cycleIdParams })
  async deleteCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reviewsService.deleteCycle(u.orgId, cycleId);
  }

  private async canManagePerformance(user: CurrentUserContext): Promise<boolean> {
    if (user.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:performance:manage");
  }
}
