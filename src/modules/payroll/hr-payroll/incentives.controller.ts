import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { IncentivesService } from "./incentives.service";
import {
  approveIncentiveSchema,
  createIncentiveConfigSchema,
  incentivesQuerySchema,
  type ApproveIncentiveInput,
  type CreateIncentiveConfigInput,
  type IncentivesQueryInput,
} from "./dto/payroll.schemas";

@RequireModule("payroll")
@Controller("hr/incentives")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class IncentivesController {
  constructor(private readonly incentives: IncentivesService) {}

  @Get()
  @RequirePermission("hr:payroll:view")
  list(
    @Query(new ZodValidationPipe(incentivesQuerySchema)) query: IncentivesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.incentives.getIncentives(u.orgId, query);
  }

  @Get("config")
  @RequirePermission("hr:payroll:view")
  listConfig(@CurrentUser() u: CurrentUserContext) {
    return this.incentives.getIncentiveConfigs(u.orgId);
  }

  @Post("config")
  @HttpCode(201)
  @RequirePermission("hr:payroll:approve")
  createConfig(
    @Body(new ZodValidationPipe(createIncentiveConfigSchema)) body: CreateIncentiveConfigInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.incentives.createConfig(u, body.incentiveRate);
  }

  @Get("stats")
  @RequirePermission("hr:payroll:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.incentives.getIncentiveStats(u.orgId);
  }

  @Patch(":incentiveId/approve")
  @Idempotent("payroll.incentive.approve")
  @RequirePermission("hr:payroll:approve")
  async approve(
    @Param("incentiveId", ParseIntPipe) incentiveId: number,
    @Body(new ZodValidationPipe(approveIncentiveSchema)) body: ApproveIncentiveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.incentives.approveIncentive(u, incentiveId, body);
    if (!result.ok) throw new NotFoundException("Incentive not found.");
    return { success: true };
  }

  @Patch(":incentiveId/reject")
  @Idempotent("payroll.incentive.reject")
  @RequirePermission("hr:payroll:approve")
  async reject(
    @Param("incentiveId", ParseIntPipe) incentiveId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.incentives.rejectIncentive(u, incentiveId);
    if (!result.ok) throw new NotFoundException("Incentive not found.");
    return { success: true };
  }
}
