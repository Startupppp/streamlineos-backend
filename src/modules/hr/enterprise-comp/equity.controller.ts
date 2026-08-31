import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const grantIdParams = z.object({ grantId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/comp/equity")
@UseGuards(JwtAuthGuard)
export class EquityController {
  constructor(private readonly service: EquityService) {}

  @Get("grants")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  @Validate({ query: listEquityGrantsSchema })
  listGrants(
    @Query() query: ListEquityGrantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listGrants(u.orgId, query);
  }

  @Post("grants")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  @HttpCode(201)
  @Validate({ body: createEquityGrantSchema })
  createGrant(
    @Body() body: CreateEquityGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createGrant(u.orgId, u.userId, body);
  }

  @Get("grants/:grantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  @Validate({ params: grantIdParams })
  getGrant(
    @Param("grantId", ParseIntPipe) grantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getGrant(u.orgId, grantId);
  }

  @Patch("grants/:grantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  @Validate({ params: grantIdParams, body: updateEquityGrantSchema })
  updateGrant(
    @Param("grantId", ParseIntPipe) grantId: number,
    @Body() body: UpdateEquityGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateGrant(u.orgId, grantId, u.userId, body);
  }

  @Get("grants/:grantId/vesting-schedule")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  @Validate({ params: grantIdParams })
  vestingSchedule(
    @Param("grantId", ParseIntPipe) grantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVestingSchedule(u.orgId, grantId);
  }

  @Get("grants/:grantId/exit-treatment")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:view")
  @Validate({ params: grantIdParams, query: exitTreatmentQuerySchema })
  exitTreatment(
    @Param("grantId", ParseIntPipe) grantId: number,
    @Query() query: ExitTreatmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getExitTreatment(u.orgId, grantId, query.exitDate);
  }

  @Post("exercises")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:equity:manage")
  @HttpCode(201)
  @Validate({ body: createExerciseSchema })
  recordExercise(
    @Body() body: CreateExerciseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.recordExercise(u.orgId, u.userId, body);
  }
}
