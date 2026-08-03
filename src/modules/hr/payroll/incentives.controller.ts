import {
  Body,
  Controller,
  ForbiddenException,
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
import { AccessService } from "../../access/access.service";
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
  constructor(
    private readonly incentives: IncentivesService,
    private readonly access: AccessService,
  ) {}

  private async canApproveIncentives(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("crm:incentives:approve");
  }

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
  @RequirePermission("hr:payroll:view")
  async createConfig(
    @Body(new ZodValidationPipe(createIncentiveConfigSchema)) body: CreateIncentiveConfigInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.canApproveIncentives(u))) {
      throw new ForbiddenException("Only admins can manage incentives.");
    }
    return this.incentives.createConfig(u.orgId, u.userId, body.incentiveRate);
  }

  @Get("stats")
  @RequirePermission("hr:payroll:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.incentives.getIncentiveStats(u.orgId);
  }

  @Patch(":incentiveId/approve")
  @RequirePermission("hr:payroll:view")
  async approve(
    @Param("incentiveId", ParseIntPipe) incentiveId: number,
    @Body(new ZodValidationPipe(approveIncentiveSchema)) body: ApproveIncentiveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.canApproveIncentives(u))) {
      throw new ForbiddenException("Only admins can manage incentives.");
    }
    const result = await this.incentives.approveIncentive(u.orgId, u.userId, incentiveId, body);
    if (!result.ok) throw new NotFoundException("Incentive not found.");
    return { success: true };
  }

  @Patch(":incentiveId/reject")
  @RequirePermission("hr:payroll:view")
  async reject(
    @Param("incentiveId", ParseIntPipe) incentiveId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.canApproveIncentives(u))) {
      throw new ForbiddenException("Only admins can manage incentives.");
    }
    const result = await this.incentives.rejectIncentive(u.orgId, incentiveId);
    if (!result.ok) throw new NotFoundException("Incentive not found.");
    return { success: true };
  }
}
