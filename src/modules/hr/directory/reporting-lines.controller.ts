import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ReportingLineService } from "../../directory/reporting-line.service";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "./employees-scope";
import {
  managerCoverageReportSchema,
  reportingLineViewSchema,
} from "./dto/reporting-lines-response.schemas";

const employeeUserIdParams = z.object({ employeeUserId: z.string().min(1).max(128) }).strict();

@RequireModule("hr")
@Controller("hr/reporting-lines")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingLinesController {
  constructor(
    private readonly reportingLines: ReportingLineService,
    private readonly access: AccessService,
  ) {}

  @Get("coverage")
  @RequirePermission("hr:employees:view")
  @ResponseSchema(managerCoverageReportSchema)
  coverage(@CurrentUser() actor: CurrentUserContext) {
    return this.reportingLines.coverage(actor.orgId);
  }

  @Get(":employeeUserId")
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeUserIdParams })
  @ResponseSchema(reportingLineViewSchema)
  async line(@Param("employeeUserId") employeeUserId: string, @CurrentUser() actor: CurrentUserContext) {
    const read = await resolveEmployeesScope(this.access, actor);
    const line = await this.reportingLines.getLine(read, employeeUserId);
    if (!line) throw new NotFoundException("Employee not found.");
    return line;
  }
}
