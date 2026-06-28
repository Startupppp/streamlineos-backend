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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { BranchContext } from "../leads/branch-filter";
import { EmployeesService } from "./employees.service";
import { EmployeeMutationsService } from "./employee-mutations.service";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { AccessService } from "../access/access.service";
import { userCan } from "./ability.helpers";
import { buildEmployeeProfileHtml } from "./profile-pdf.html";
import {
  availabilitySchema,
  findExpertSchema,
  listEmployeesSchema,
  onboardEmployeeSchema,
  updateEmployeeSchema,
  type AvailabilityInput,
  type FindExpertInput,
  type ListEmployeesInput,
  type OnboardEmployeeInput,
  type UpdateEmployeeInput,
} from "./dto/hr-directory.schemas";

@Controller("hr/employees")
@UseGuards(JwtAuthGuard)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly mutations: EmployeeMutationsService,
    private readonly celebrations: CelebrationsService,
    private readonly skills: EmployeeSkillsService,
    private readonly access: AccessService,
  ) {}

  @Post("onboard")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  onboard(
    @Body(new ZodValidationPipe(onboardEmployeeSchema)) body: OnboardEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.onboardEmployee(u, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  listEmployees(
    @Query(new ZodValidationPipe(listEmployeesSchema)) query: ListEmployeesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const branch: BranchContext = {
      role: u.role ?? "",
      branchId: u.branchId ?? null,
      userId: u.userId,
    };
    const search = query.search ?? query.q;
    return this.employees.listEmployees(u.orgId, branch, {
      page: query.page,
      limit: query.limit,
      search,
    });
  }

  @Get("stats")
  stats(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    const targetId = userId ?? u.userId;
    if (targetId !== u.userId && !userCan(u, "read", "hr:employees")) {
      throw new ForbiddenException("Access denied.");
    }
    return this.employees.getStats(u.orgId, targetId);
  }

  @Get("anniversary-feed")
  anniversaryFeed(@CurrentUser() u: CurrentUserContext) {
    return this.celebrations.getAnniversaryFeed(u.orgId);
  }

  @Get("availability")
  availability(
    @Query(new ZodValidationPipe(availabilitySchema)) query: AvailabilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.celebrations.getAvailability(u.orgId, query.userIds);
  }

  @Get("check-email")
  checkEmail(@Query("email") email: string | undefined) {
    if (!email) throw new BadRequestException("Email is required");
    return this.employees.checkEmail(email);
  }

  @Get("find-expert")
  findExpert(
    @Query(new ZodValidationPipe(findExpertSchema)) query: FindExpertInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.skills.findExpert(u.orgId, query);
  }

  @Get("skills-matrix")
  skillsMatrix(@CurrentUser() u: CurrentUserContext) {
    return this.skills.getSkillsMatrix(u.orgId);
  }

  @Get("projects")
  projects(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    return this.employees.getProjects(u.orgId, userId || u.userId);
  }

  @Get("tickets")
  tickets(@Query("userId") userId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    return this.employees.getTickets(u.orgId, userId || u.userId);
  }

  @Get(":employeeId/reports-to-me")
  reportsToMe(@Param("employeeId") employeeId: string, @CurrentUser() u: CurrentUserContext) {
    return this.employees.getReportsToMe(u.orgId, employeeId);
  }

  @Get(":employeeId/manager-scorecard")
  managerScorecard(@Param("employeeId") employeeId: string, @CurrentUser() u: CurrentUserContext) {
    const allowed = u.userId === employeeId || userCan(u, "manage", "hr:performance");
    if (!allowed) throw new ForbiddenException("Access denied");
    return this.employees.getManagerScorecard(u.orgId, employeeId);
  }

  @Get(":employeeId/profile-pdf")
  async profilePdf(
    @Param("employeeId") employeeId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }

    const employee = await this.employees.getEmployee(u.orgId, employeeId);
    if (!employee) throw new NotFoundException("Employee not found");

    const html = buildEmployeeProfileHtml(employee);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="employee-profile-${employeeId}.html"`);
    res.send(html);
  }

  @Get(":employeeId")
  async getEmployeeDetail(
    @Param("employeeId") employeeId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const employee = await this.mutations.getEmployeeDetail(u.orgId, employeeId);
    if (!employee) throw new NotFoundException("Employee not found.");
    return employee;
  }

  @Patch(":employeeId")
  updateEmployee(
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mutations.updateEmployee(u, employeeId, body);
  }
}
