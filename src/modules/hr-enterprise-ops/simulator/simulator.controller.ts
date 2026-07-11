import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { SimulatorService } from "./simulator.service";
import {
  simulatePolicySchema,
  simulateLeaveBalanceSchema,
  simulateApprovalRoutingSchema,
  simulatePayrollImpactSchema,
  compareSchema,
  listSimulationsSchema,
  type SimulatePolicyInput,
  type SimulateLeaveBalanceInput,
  type SimulateApprovalRoutingInput,
  type SimulatePayrollImpactInput,
  type CompareInput,
  type ListSimulationsInput,
} from "../dto/simulator.schemas";

@RequireModule("hr")
@Controller("hr/enterprise/ops/simulator")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SimulatorController {
  constructor(
    private readonly svc: SimulatorService,
    private readonly access: AccessService,
  ) {}

  private async canViewSalary(user: CurrentUserContext): Promise<boolean> {
    if (user.isOrgOwner || user.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:payroll:view") || perms.has("hr:salary:view");
  }

  @Post("simulate/policy")
  @RequirePermission("hr:policies:manage")
  simulatePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(simulatePolicySchema)) body: SimulatePolicyInput,
  ) {
    return this.svc.simulatePolicy(user.orgId, user.userId, body);
  }

  @Post("simulate/leave-balance")
  @RequirePermission("hr:policies:manage")
  simulateLeaveBalance(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(simulateLeaveBalanceSchema)) body: SimulateLeaveBalanceInput,
  ) {
    return this.svc.simulateLeaveBalance(user.orgId, user.userId, body);
  }

  @Post("simulate/approval-routing")
  @RequirePermission("hr:policies:manage")
  simulateApprovalRouting(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(simulateApprovalRoutingSchema)) body: SimulateApprovalRoutingInput,
  ) {
    return this.svc.simulateApprovalRouting(user.orgId, user.userId, body);
  }

  @Post("simulate/payroll-impact")
  @RequirePermission("hr:policies:manage")
  async simulatePayrollImpact(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(simulatePayrollImpactSchema)) body: SimulatePayrollImpactInput,
  ) {
    const hasSalary = await this.canViewSalary(user);
    if (!hasSalary) {
      throw new ForbiddenException("hr:payroll:view or hr:salary:view permission required");
    }
    return this.svc.simulatePayrollImpact(user.orgId, user.userId, body);
  }

  @Get("compare")
  @RequirePermission("hr:policies:manage")
  compare(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(compareSchema)) query: CompareInput,
  ) {
    return this.svc.compare(user.orgId, user.userId, query);
  }

  @Get("history")
  @RequirePermission("hr:policies:manage")
  listHistory(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listSimulationsSchema)) query: ListSimulationsInput,
  ) {
    return this.svc.listHistory(user.orgId, query);
  }
}
