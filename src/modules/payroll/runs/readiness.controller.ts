import { Controller, Get, NotFoundException, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { AccessService } from "../../access/access.service";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { PayrollReadinessService } from "./readiness.service";
import { resolvePayrollRunsViewScope } from "../payroll-scope";
import { readinessQuerySchema, type ReadinessQuery } from "./dto/runs.schemas";
import { payrollReadinessResponseSchema } from "./dto/readiness-response.schemas";

@RequireModule("payroll")
@Controller("payroll/readiness")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollReadinessController {
  constructor(
    private readonly readiness: PayrollReadinessService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @ResponseSchema(payrollReadinessResponseSchema)
  @Validate({ query: readinessQuerySchema })
  async get(@Query() query: ReadinessQuery, @CurrentUser() u: CurrentUserContext) {
    const read = await resolvePayrollRunsViewScope(this.access, u);
    if (!read.unrestricted) throw new NotFoundException("Payroll readiness not found");
    return this.readiness.getReadiness(u.orgId, query.month);
  }
}
