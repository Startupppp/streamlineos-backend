import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { HrReportingLinesService } from "./reporting-lines.service";
import {
  reportingManagerPolicySchema,
  updateReportingManagerPolicySchema,
  type UpdateReportingManagerPolicyInput,
} from "./dto/reporting-lines-line.schemas";

@RequireModule("hr")
@Controller("hr/reporting-manager-policy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingManagerPolicyController {
  constructor(private readonly lines: HrReportingLinesService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  @ResponseSchema(reportingManagerPolicySchema)
  get(@CurrentUser() actor: CurrentUserContext) {
    return this.lines.getPolicy(actor);
  }

  @Patch()
  @RequirePermission("hr:reporting-lines:override")
  @Idempotent("hr.reporting-manager-policy.update")
  @Validate({ body: updateReportingManagerPolicySchema })
  @ResponseSchema(reportingManagerPolicySchema)
  update(@Body() body: UpdateReportingManagerPolicyInput, @CurrentUser() actor: CurrentUserContext) {
    return this.lines.updatePolicy(actor, body);
  }
}
