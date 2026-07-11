import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { EquityService } from "./equity.service";
import {
  createEquityGrantSchema,
  updateEquityGrantSchema,
  listEquityGrantsSchema,
  createExerciseSchema,
  exitTreatmentQuerySchema,
  type CreateEquityGrantInput,
  type UpdateEquityGrantInput,
  type ListEquityGrantsInput,
  type CreateExerciseInput,
  type ExitTreatmentQuery,
} from "./dto/enterprise-comp.schemas";

@RequireModule("hr")
@Controller("hr/enterprise/comp/equity")
@UseGuards(JwtAuthGuard)
export class EquityController {
  constructor(private readonly service: EquityService) {}

  @Get("grants")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  listGrants(
    @Query(new ZodValidationPipe(listEquityGrantsSchema)) query: ListEquityGrantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listGrants(u.orgId, query);
  }

  @Post("grants")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  @HttpCode(201)
  createGrant(
    @Body(new ZodValidationPipe(createEquityGrantSchema)) body: CreateEquityGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createGrant(u.orgId, u.userId, body);
  }

  @Get("grants/:grantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  getGrant(
    @Param("grantId", ParseIntPipe) grantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getGrant(u.orgId, grantId);
  }

  @Patch("grants/:grantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  updateGrant(
    @Param("grantId", ParseIntPipe) grantId: number,
    @Body(new ZodValidationPipe(updateEquityGrantSchema)) body: UpdateEquityGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateGrant(u.orgId, grantId, u.userId, body);
  }

  @Get("grants/:grantId/vesting-schedule")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  vestingSchedule(
    @Param("grantId", ParseIntPipe) grantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVestingSchedule(u.orgId, grantId);
  }

  @Get("grants/:grantId/exit-treatment")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  exitTreatment(
    @Param("grantId", ParseIntPipe) grantId: number,
    @Query(new ZodValidationPipe(exitTreatmentQuerySchema)) query: ExitTreatmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getExitTreatment(u.orgId, grantId, query.exitDate);
  }

  @Post("exercises")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  @HttpCode(201)
  recordExercise(
    @Body(new ZodValidationPipe(createExerciseSchema)) body: CreateExerciseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.recordExercise(u.orgId, u.userId, body);
  }
}
