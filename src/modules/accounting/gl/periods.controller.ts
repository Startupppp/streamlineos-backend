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
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  periodListResponseSchema,
  generatePeriodsResponseSchema,
  periodCloseChecklistResponseSchema,
  periodMutationResponseSchema,
  reopenPeriodResponseSchema,
} from "./dto/gl-response.schemas";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/periods")
@UseGuards(JwtAuthGuard)
export class AccountingGlPeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @ResponseSchema(periodListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  listPeriods(@CurrentUser() u: CurrentUserContext) {
    return this.periods.listPeriods(u.orgId);
  }

  @Post()
  @ResponseSchema(generatePeriodsResponseSchema)
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
  @ResponseSchema(periodCloseChecklistResponseSchema)
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
  @ResponseSchema(periodMutationResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  @HttpCode(200)
  @Idempotent("accounting.period.close")
  @Validate({ params: periodIdParams })
  closePeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.closePeriod(u.orgId, u.userId, periodId);
  }

  @Post(":periodId/lock")
  @ResponseSchema(periodMutationResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  @HttpCode(200)
  @Idempotent("accounting.period.lock")
  @Validate({ params: periodIdParams })
  lockPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.lockPeriod(u.orgId, u.userId, periodId);
  }

  @Post(":periodId/reopen")
  @ResponseSchema(reopenPeriodResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:reopen")
  @HttpCode(200)
  @Idempotent("accounting.period.reopen")
  @Validate({ params: periodIdParams })
  reopenPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.reopenPeriod(u.orgId, u.userId, periodId);
  }
}
