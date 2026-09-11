import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
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
import { EmployeeOnboardingService } from "./employee-onboarding.service";
import { EmployeeBulkOnboardingService } from "./employee-bulk-onboarding.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { AccessService } from "../../access/access.service";
import {
  resolveEmployeesManageScope,
  resolveEmployeesScope,
} from "./employees-scope";
import { buildEmployeeProfilePdf } from "./profile-pdf";
import {
  availabilitySchema,
  bulkOnboardEmployeesSchema,
  employeeUserQuerySchema,
  findExpertSchema,
  listEmployeesSchema,
  onboardEmployeeSchema,
  skillsMatrixQuerySchema,
  updateEmployeeSchema,
  type AvailabilityInput,
  type BulkOnboardEmployeesInput,
  type EmployeeUserQueryInput,
  type FindExpertInput,
  type ListEmployeesInput,
  type OnboardEmployeeInput,
  type SkillsMatrixQueryInput,
  type UpdateEmployeeInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  onboardResponseSchema,
  bulkOnboardResultSchema,
  employeeListPageSchema,
  employeeStatsSchema,
  anniversaryFeedSchema,
  availabilityListSchema,
  checkEmailSchema,
  findExpertResponseSchema,
  skillsMatrixSchema,
  employeeProjectsSchema,
  employeeTicketsSchema,
  reportsToMeListSchema,
  managerScorecardSchema,
  employeeDetailSchema,
  successSchema,
} from "./dto/directory-response.schemas";
import { z } from "zod";

const employeeIdParams = z.object({ employeeId: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly analytics: EmployeeAnalyticsService,
    private readonly mutations: EmployeeMutationsService,
    private readonly onboarding: EmployeeOnboardingService,
    private readonly bulkOnboarding: EmployeeBulkOnboardingService,
    private readonly celebrations: CelebrationsService,
    private readonly skills: EmployeeSkillsService,
    private readonly access: AccessService,
  ) {}

  @Post("onboard")
  @ResponseSchema(onboardResponseSchema)
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(201)
  @Validate({ body: onboardEmployeeSchema })
  onboard(
    @Body() body: OnboardEmployeeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboarding.onboardEmployee(currentUser, body);
  }

  @Post("onboard/bulk")
  @ResponseSchema(bulkOnboardResultSchema)
  @RequirePermission("hr:onboarding:manage")
  @Idempotent("hr.employees.onboard-bulk")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-bulk-onboard")
  @HttpCode(200)
  @Validate({ body: bulkOnboardEmployeesSchema })
  onboardBulk(
    @Body() body: BulkOnboardEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.bulkOnboarding.onboardEmployeesBulk(currentUser, body.employees);
  }

  @Get()
  @ResponseSchema(employeeListPageSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: listEmployeesSchema })
  async listEmployees(
    @Query() query: ListEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    const search = query.search ?? query.q;
    return this.employees.listEmployees(read, {
      cursor: query.cursor,
      limit: query.limit,
      search,
      departmentId: query.departmentId,
      isActive: query.isActive,
      role: query.role,
    });
  }

  private async resolveTargetUserId(
    currentUser: CurrentUserContext,
    requested: string | undefined,
  ): Promise<string> {
    const targetUserId = requested ?? currentUser.userId;
    const read = await resolveEmployeesScope(this.access, currentUser);
    await this.employees.assertEmployeeVisible(read, targetUserId);
    return targetUserId;
  }

  @Get("stats")
  @ResponseSchema(employeeStatsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: employeeUserQuerySchema })
  async stats(
    @Query() query: EmployeeUserQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const targetId = await this.resolveTargetUserId(currentUser, query.userId);
    return this.analytics.getStats(currentUser.orgId, targetId);
  }

  @Get("anniversary-feed")
  @ResponseSchema(anniversaryFeedSchema)
  @RequirePermission("hr:employees:view")
  async anniversaryFeed(@CurrentUser() currentUser: CurrentUserContext) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getAnniversaryFeed(read);
  }

  @Get("availability")
  @ResponseSchema(availabilityListSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: availabilitySchema })
  async availability(
    @Query() query: AvailabilityInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getAvailability(read, query.userIds);
  }

  @Get("check-email")
  @ResponseSchema(checkEmailSchema)
  @RequirePermission("hr:onboarding:manage")
  checkEmail(
    @Query("email") email: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (!email) throw new BadRequestException("Email is required");
    return this.employees.checkEmail(currentUser.orgId, email);
  }

  @Get("find-expert")
  @ResponseSchema(findExpertResponseSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: findExpertSchema })
  async findExpert(
    @Query() query: FindExpertInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.skills.findExpert(read, query);
  }

  @Get("skills-matrix")
  @ResponseSchema(skillsMatrixSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: skillsMatrixQuerySchema })
  async skillsMatrix(
    @Query() query: SkillsMatrixQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.skills.getSkillsMatrix(read, query);
  }

  @Get("projects")
  @ResponseSchema(employeeProjectsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: employeeUserQuerySchema })
  async projects(
    @Query() query: EmployeeUserQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getProjects(currentUser.orgId, await this.resolveTargetUserId(currentUser, query.userId));
  }

  @Get("tickets")
  @ResponseSchema(employeeTicketsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: employeeUserQuerySchema })
  async tickets(
    @Query() query: EmployeeUserQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getTickets(currentUser.orgId, await this.resolveTargetUserId(currentUser, query.userId));
  }

  @Get(":employeeId/reports-to-me")
  @ResponseSchema(reportsToMeListSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeIdParams })
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
  @Validate({ params: employeeIdParams })
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
  @Validate({ params: employeeIdParams })
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
  @Validate({ params: employeeIdParams })
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
  @Validate({ params: employeeIdParams, body: updateEmployeeSchema })
  updateEmployee(
    @Param("employeeId") employeeId: string,
    @Body() body: UpdateEmployeeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.mutations.updateEmployee(currentUser, employeeId, body);
  }
}
