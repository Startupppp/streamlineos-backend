import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
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
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts"
import { simulatePolicyResponseSchema, simulateLeaveBalanceResponseSchema, simulateApprovalRoutingResponseSchema, simulatePayrollImpactResponseSchema, compareSimulationResponseSchema, listSimulationsResponseSchema } from "../dto/enterprise-ops-response.schemas"

@RequireModule("hr")
@Controller("hr/enterprise/ops/simulator")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SimulatorController {
  constructor(
    private readonly svc: SimulatorService,
    private readonly access: AccessService,
  ) {}

  private async canViewSalary(user: CurrentUserContext): Promise<boolean> {
    if (user.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:payroll:view") || perms.has("hr:salary:view");
  }

  @ResponseSchema(simulatePolicyResponseSchema)
  @Post("simulate/policy")
  @RequirePermission("hr:policies:manage")
  @Validate({ body: simulatePolicySchema })
  simulatePolicy(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: SimulatePolicyInput,
  ) {
    return this.svc.simulatePolicy(user.orgId, user.userId, body);
  }

  @ResponseSchema(simulateLeaveBalanceResponseSchema)
  @Post("simulate/leave-balance")
  @RequirePermission("hr:policies:manage")
  @Validate({ body: simulateLeaveBalanceSchema })
  simulateLeaveBalance(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: SimulateLeaveBalanceInput,
  ) {
    return this.svc.simulateLeaveBalance(user.orgId, user.userId, body);
  }

  @ResponseSchema(simulateApprovalRoutingResponseSchema)
  @Post("simulate/approval-routing")
  @RequirePermission("hr:policies:manage")
  @Validate({ body: simulateApprovalRoutingSchema })
  simulateApprovalRouting(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: SimulateApprovalRoutingInput,
  ) {
    return this.svc.simulateApprovalRouting(user.orgId, user.userId, body);
  }

  @ResponseSchema(simulatePayrollImpactResponseSchema)
  @Post("simulate/payroll-impact")
  @RequirePermission("hr:policies:manage")
  @Validate({ body: simulatePayrollImpactSchema })
  async simulatePayrollImpact(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: SimulatePayrollImpactInput,
  ) {
    const hasSalary = await this.canViewSalary(user);
    if (!hasSalary) {
      throw new ForbiddenException("hr:payroll:view or hr:salary:view permission required");
    }
    return this.svc.simulatePayrollImpact(user.orgId, user.userId, body);
  }

  @ResponseSchema(compareSimulationResponseSchema)
  @Get("compare")
  @RequirePermission("hr:policies:manage")
  @Validate({ query: compareSchema })
  compare(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: CompareInput,
  ) {
    return this.svc.compare(user.orgId, user.userId, query);
  }

  @ResponseSchema(listSimulationsResponseSchema)
  @Get("history")
  @RequirePermission("hr:policies:manage")
  @Validate({ query: listSimulationsSchema })
  listHistory(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListSimulationsInput,
  ) {
    return this.svc.listHistory(user.orgId, query);
  }
}
