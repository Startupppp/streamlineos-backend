import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PeriodsService } from "./periods.service";
import { generatePeriodsSchema, type GeneratePeriodsInput } from "./dto/periods.schemas";

@RequireModule("accounting")
@Controller("accounting/periods")
@UseGuards(JwtAuthGuard)
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  listPeriods(@CurrentUser() u: CurrentUserContext) {
    return this.periods.listPeriods(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  @HttpCode(201)
  generatePeriods(
    @Body(new ZodValidationPipe(generatePeriodsSchema)) body: GeneratePeriodsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.generatePeriods(u.orgId, u.userId, body);
  }

  @Get(":periodId/close-checklist")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  getCloseChecklist(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.getCloseChecklist(u.orgId, periodId);
  }

  @Post(":periodId/close")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  @HttpCode(200)
  closePeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.closePeriod(u.orgId, u.userId, periodId);
  }

  @Post(":periodId/lock")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  @HttpCode(200)
  lockPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.lockPeriod(u.orgId, u.userId, periodId);
  }

  @Post(":periodId/reopen")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:reopen")
  @HttpCode(200)
  reopenPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.reopenPeriod(u.orgId, u.userId, periodId);
  }
}
