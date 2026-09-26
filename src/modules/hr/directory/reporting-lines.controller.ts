import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { HrReportingLinesService } from "./reporting-lines.service";
import {
  managerCandidatesQuerySchema,
  managerCoverageDetailSchema,
  reportingLineDetailSchema,
  setReportingLineResponseSchema,
  setReportingLineSchema,
  type ManagerCandidatesQuery,
  type SetReportingLineInput,
} from "./dto/reporting-lines-line.schemas";
import { employeeUserIdParamsSchema, managerCandidatesResponseSchema } from "./dto/reporting-lines-shared.schemas";

/**
 * The static routes are declared before `:employeeUserId`: Express matches in registration order,
 * so `coverage` and `manager-candidates` declared after it would be read as an employee id.
 */
@RequireModule("hr")
@Controller("hr/reporting-lines")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingLinesController {
  constructor(private readonly lines: HrReportingLinesService) {}

  @Get("coverage")
  @RequirePermission("hr:employees:view")
  @ResponseSchema(managerCoverageDetailSchema)
  coverage(@CurrentUser() actor: CurrentUserContext) {
    return this.lines.coverage(actor);
  }

  @Get("manager-candidates")
  @RequirePermission("hr:employees:view")
  @Validate({ query: managerCandidatesQuerySchema })
  @ResponseSchema(managerCandidatesResponseSchema)
  managerCandidates(@Query() query: ManagerCandidatesQuery, @CurrentUser() actor: CurrentUserContext) {
    return this.lines.managerCandidates(actor, query);
  }

  @Get(":employeeUserId")
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeUserIdParamsSchema })
  @ResponseSchema(reportingLineDetailSchema)
  line(@Param("employeeUserId") employeeUserId: string, @CurrentUser() actor: CurrentUserContext) {
    return this.lines.getLine(actor, employeeUserId);
  }

  @Put(":employeeUserId")
  @RequirePermission("hr:reporting-lines:manage")
  @Idempotent("hr.reporting-lines.set")
  @HttpCode(200)
  @Validate({ params: employeeUserIdParamsSchema, body: setReportingLineSchema })
  @ResponseSchema(setReportingLineResponseSchema)
  setLine(
    @Param("employeeUserId") employeeUserId: string,
    @Body() body: SetReportingLineInput,
    @CurrentUser() actor: CurrentUserContext,
  ) {
    return this.lines.setLine(actor, employeeUserId, body);
  }

  @Post(":employeeUserId/confirm-fallback")
  @RequirePermission("hr:reporting-lines:manage")
  @Idempotent("hr.reporting-lines.confirm-fallback")
  @HttpCode(200)
  @Validate({ params: employeeUserIdParamsSchema })
  @BodylessAction()
  @ResponseSchema(reportingLineDetailSchema)
  confirmFallback(@Param("employeeUserId") employeeUserId: string, @CurrentUser() actor: CurrentUserContext) {
    return this.lines.confirmFallback(actor, employeeUserId);
  }
}
