import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { PayrollReadinessService } from "./readiness.service";
import { readinessQuerySchema, type ReadinessQuery } from "./dto/runs.schemas";
import { payrollReadinessResponseSchema } from "./dto/readiness-response.schemas";

@RequireModule("payroll")
@Controller("payroll/readiness")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollReadinessController {
  constructor(private readonly readiness: PayrollReadinessService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @ResponseSchema(payrollReadinessResponseSchema)
  @Validate({ query: readinessQuerySchema })
  get(@Query() query: ReadinessQuery, @CurrentUser() u: CurrentUserContext) {
    return this.readiness.getReadiness(u.orgId, query.month);
  }
}
