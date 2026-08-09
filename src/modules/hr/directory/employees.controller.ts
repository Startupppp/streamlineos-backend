import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EmployeesService } from "./employees.service";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { EmployeeOnboardingService } from "./employee-onboarding.service";
import { EmployeeBulkOnboardingService } from "./employee-bulk-onboarding.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "./employees-scope";
import { buildEmployeeProfilePdf } from "./profile-pdf";
import {
  availabilitySchema,
  bulkOnboardEmployeesSchema,
  findExpertSchema,
  listEmployeesSchema,
  onboardEmployeeSchema,
  updateEmployeeSchema,
  type AvailabilityInput,
  type BulkOnboardEmployeesInput,
  type FindExpertInput,
  type ListEmployeesInput,
  type OnboardEmployeeInput,
  type UpdateEmployeeInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly mutations: EmployeeMutationsService,
    private readonly onboarding: EmployeeOnboardingService,
    private readonly bulkOnboarding: EmployeeBulkOnboardingService,
    private readonly celebrations: CelebrationsService,
    private readonly skills: EmployeeSkillsService,
    private readonly access: AccessService,
  ) {}

  @Post("onboard")
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(201)
  onboard(
    @Body(new ZodValidationPipe(onboardEmployeeSchema)) body: OnboardEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.onboardEmployee(u, body);
  }

  @Post("onboard/bulk")
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(200)
  onboardBulk(
    @Body(new ZodValidationPipe(bulkOnboardEmployeesSchema)) body: BulkOnboardEmployeesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bulkOnboarding.onboardEmployeesBulk(u, body.employees);
  }

  @Get()
  @RequirePermission("hr:employees:view")
  async listEmployees(
    @Query(new ZodValidationPipe(listEmployeesSchema)) query: ListEmployeesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    const search = query.search ?? query.q;
    return this.employees.listEmployees(u.orgId, u.userId, {
      page: query.page,
      limit: query.limit,
      search,
      departmentId: query.departmentId,
      isActive: query.isActive,
      role: query.role,
    }, scope);
  }

  private async resolveTargetUserId(
    u: CurrentUserContext,
    requested: string | undefined,
  ): Promise<string> {
    if (!requested || requested === u.userId) return u.userId;
    const scope = await resolveEmployeesScope(this.access, u);
    if (scope !== "all") {
      throw new ForbiddenException("Not allowed to view another employee's records");
    }
    return requested;
  }

  @Get("stats")
  @RequirePermission("hr:employees:view")
  async stats(
    @Query("userId") userId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const targetId = await this.resolveTargetUserId(u, userId);
    return this.employees.getStats(u.orgId, targetId);
  }

  @Get("anniversary-feed")
  @RequirePermission("hr:employees:view")
  anniversaryFeed(@CurrentUser() u: CurrentUserContext) {
    return this.celebrations.getAnniversaryFeed(u.orgId);
  }

  @Get("availability")
  @RequirePermission("hr:employees:view")
  availability(
    @Query(new ZodValidationPipe(availabilitySchema)) query: AvailabilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.celebrations.getAvailability(u.orgId, query.userIds);
  }

  @Get("check-email")
  @RequirePermission("hr:onboarding:manage")
  checkEmail(
    @Query("email") email: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!email) throw new BadRequestException("Email is required");
    return this.employees.checkEmail(u.orgId, email);
  }

  @Get("find-expert")
  @RequirePermission("hr:employees:view")
  findExpert(
    @Query(new ZodValidationPipe(findExpertSchema)) query: FindExpertInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.skills.findExpert(u.orgId, query);
  }

  @Get("skills-matrix")
  @RequirePermission("hr:employees:view")
  skillsMatrix(@CurrentUser() u: CurrentUserContext) {
    return this.skills.getSkillsMatrix(u.orgId);
  }

  @Get("projects")
  @RequirePermission("hr:employees:view")
  async projects(
    @Query("userId") userId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employees.getProjects(u.orgId, await this.resolveTargetUserId(u, userId));
  }

  @Get("tickets")
  @RequirePermission("hr:employees:view")
  async tickets(
    @Query("userId") userId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employees.getTickets(u.orgId, await this.resolveTargetUserId(u, userId));
  }

  @Get(":employeeId/reports-to-me")
  @RequirePermission("hr:employees:view")
  reportsToMe(@Param("employeeId") employeeId: string, @CurrentUser() u: CurrentUserContext) {
    return this.employees.getReportsToMe(u.orgId, employeeId);
  }

  @Get(":employeeId/manager-scorecard")
  @RequirePermission("hr:employees:view")
  managerScorecard(@Param("employeeId") employeeId: string, @CurrentUser() u: CurrentUserContext) {
    return this.employees.getManagerScorecard(u.orgId, employeeId);
  }

  @Get(":employeeId/profile-pdf")
  @RequirePermission("hr:employees:manage")
  async profilePdf(
    @Param("employeeId") employeeId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const employee = await this.mutations.getEmployeeDetail(u.orgId, employeeId);
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
  @RequirePermission("hr:employees:view")
  async getEmployeeDetail(
    @Param("employeeId") employeeId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const employee = await this.mutations.getEmployeeDetail(u.orgId, employeeId);
    if (!employee) throw new NotFoundException("Employee not found.");
    return employee;
  }

  @Patch(":employeeId")
  @RequirePermission("hr:employees:update")
  updateEmployee(
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.updateEmployee(u, employeeId, body);
  }
}
