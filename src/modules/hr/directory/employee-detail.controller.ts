import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { EmployeesService } from "./employees.service";
import { EmployeeAnalyticsService } from "./employee-analytics.service";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { AccessService } from "../../access/access.service";
import {
  resolveEmployeesManageScope,
  resolveEmployeesScope,
} from "./employees-scope";
import { buildEmployeeProfilePdf } from "./profile-pdf";
import {
  employeeIdParamsSchema,
  updateEmployeeSchema,
  type UpdateEmployeeInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  employeeDetailSchema,
  managerScorecardSchema,
  reportsToMeListSchema,
  successSchema,
} from "./dto/directory-response.schemas";


@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeeDetailController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly analytics: EmployeeAnalyticsService,
    private readonly mutations: EmployeeMutationsService,
    private readonly access: AccessService,
  ) {}

  private async resolveTargetUserId(
    currentUser: CurrentUserContext,
    requested: string | undefined,
  ): Promise<string> {
    const targetUserId = requested ?? currentUser.userId;
    const read = await resolveEmployeesScope(this.access, currentUser);
    await this.employees.assertEmployeeVisible(read, targetUserId);
    return targetUserId;
  }

  @Get(":employeeId/reports-to-me")
  @ResponseSchema(reportsToMeListSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeIdParamsSchema })
  async reportsToMe(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getReportsToMe(
      currentUser.orgId,
      await this.resolveTargetUserId(currentUser, employeeId),
    );
  }

  @Get(":employeeId/manager-scorecard")
  @ResponseSchema(managerScorecardSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeIdParamsSchema })
  async managerScorecard(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.analytics.getManagerScorecard(
      currentUser.orgId,
      await this.resolveTargetUserId(currentUser, employeeId),
    );
  }

  @Get(":employeeId/profile-pdf")
  @ApiOkResponse({ description: "Employee profile PDF binary", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  @RequirePermission("hr:employees:manage")
  @Validate({ params: employeeIdParamsSchema })
  async profilePdf(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
    @Res() res: Response,
  ) {
    const read = await resolveEmployeesManageScope(this.access, currentUser);
    const employee = await this.mutations.getEmployeeDetail(read, employeeId);
    if (!employee) throw new NotFoundException("Employee not found");

    const { skills, ...employeeData } = employee;
    const pdf = await buildEmployeeProfilePdf(employeeData, skills);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="employee-profile-${employeeId}.pdf"`,
    );
    res.send(pdf);
  }

  @Get(":employeeId")
  @ResponseSchema(employeeDetailSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeIdParamsSchema })
  async getEmployeeDetail(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    const employee = await this.mutations.getEmployeeDetail(read, employeeId);
    if (!employee) throw new NotFoundException("Employee not found.");
    return employee;
  }

  @Patch(":employeeId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:update")
  @Validate({ params: employeeIdParamsSchema, body: updateEmployeeSchema })
  updateEmployee(
    @Param("employeeId") employeeId: string,
    @Body() body: UpdateEmployeeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.mutations.updateEmployee(currentUser, employeeId, body);
  }
}
