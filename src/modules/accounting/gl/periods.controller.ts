import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PeriodsService } from "./periods.service";
import { generatePeriodsSchema, type GeneratePeriodsInput } from "./dto/periods.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ body: generatePeriodsSchema })
  generatePeriods(
    @Body() body: GeneratePeriodsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.generatePeriods(u.orgId, u.userId, body);
  }

  @Get(":periodId/close-checklist")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  @Validate({ params: periodIdParams })
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
  @Idempotent("accounting.period.close")
  @BodylessAction()
  @Validate({ params: periodIdParams })
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
  @Idempotent("accounting.period.lock")
  @BodylessAction()
  @Validate({ params: periodIdParams })
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
  @Idempotent("accounting.period.reopen")
  @BodylessAction()
  @Validate({ params: periodIdParams })
  reopenPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.reopenPeriod(u.orgId, u.userId, periodId);
  }
}
