import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CompPlanningService } from "./comp-planning.service";
import {
  createCompCycleSchema,
  updateCompCycleSchema,
  listCompCyclesSchema,
  createRecommendationSchema,
  updateRecommendationSchema,
  calibrateRecommendationSchema,
  listRecommendationsSchema,
  approveRecommendationSchema,
  createBudgetPoolSchema,
  type CreateCompCycleInput,
  type UpdateCompCycleInput,
  type ListCompCyclesInput,
  type CreateRecommendationInput,
  type UpdateRecommendationInput,
  type CalibrateRecommendationInput,
  type ListRecommendationsInput,
  type ApproveRecommendationInput,
  type CreateBudgetPoolInput,
} from "./dto/enterprise-comp.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const cycleIdParams = z.object({ cycleId: z.coerce.number().int().positive() }).strict();
const recIdParams = z.object({ recId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/comp/planning")
@UseGuards(JwtAuthGuard)
export class CompPlanningController {
  constructor(private readonly service: CompPlanningService) {}

  @Get("cycles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ query: listCompCyclesSchema })
  listCycles(
    @Query() query: ListCompCyclesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listCycles(u.orgId, query);
  }

  @Post("cycles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @HttpCode(201)
  @Validate({ body: createCompCycleSchema })
  createCycle(
    @Body() body: CreateCompCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createCycle(u.orgId, u.userId, body);
  }

  @Get("cycles/:cycleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: cycleIdParams })
  getCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getCycle(u.orgId, cycleId);
  }

  @Patch("cycles/:cycleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: cycleIdParams, body: updateCompCycleSchema })
  updateCycle(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body() body: UpdateCompCycleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateCycle(u.orgId, cycleId, u.userId, body);
  }

  @Get("cycles/:cycleId/budget-pools")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: cycleIdParams })
  getBudgetPools(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getBudgetPools(u.orgId, cycleId);
  }

  @Post("cycles/:cycleId/budget-pools")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @HttpCode(201)
  @Validate({ params: cycleIdParams, body: createBudgetPoolSchema })
  createBudgetPool(
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body() body: CreateBudgetPoolInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createBudgetPool(u.orgId, u.userId, { ...body, cycleId });
  }

  @Get("recommendations")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ query: listRecommendationsSchema })
  listRecommendations(
    @Query() query: ListRecommendationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRecommendations(u.orgId, query);
  }

  @Post("recommendations")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @HttpCode(201)
  @Validate({ body: createRecommendationSchema })
  createRecommendation(
    @Body() body: CreateRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createRecommendation(u.orgId, u.userId, body);
  }

  @Patch("recommendations/:recId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: recIdParams, body: updateRecommendationSchema })
  updateRecommendation(
    @Param("recId", ParseIntPipe) recId: number,
    @Body() body: UpdateRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateRecommendation(u.orgId, recId, u.userId, body);
  }

  @Patch("recommendations/:recId/submit")
  @BodylessAction()
  @Idempotent("hr.comp-recommendation.submit")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: recIdParams })
  submitRecommendation(
    @Param("recId", ParseIntPipe) recId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.submitRecommendation(u.orgId, recId, u.userId);
  }

  @Patch("recommendations/:recId/calibrate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: recIdParams, body: calibrateRecommendationSchema })
  calibrateRecommendation(
    @Param("recId", ParseIntPipe) recId: number,
    @Body() body: CalibrateRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.calibrateRecommendation(u.orgId, recId, u.userId, body);
  }

  @Patch("recommendations/:recId/approve")
  @Idempotent("hr.comp-recommendation.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compensation:manage")
  @Validate({ params: recIdParams, body: approveRecommendationSchema })
  approveRecommendation(
    @Param("recId", ParseIntPipe) recId: number,
    @Body() body: ApproveRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveRecommendation(u.orgId, recId, u.userId, body);
  }
}
