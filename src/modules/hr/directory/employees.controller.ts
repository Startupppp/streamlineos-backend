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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EmployeesService } from "./employees.service";
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
  findExpertSchema,
  listEmployeesSchema,
  onboardEmployeeSchema,
  skillsMatrixQuerySchema,
  updateEmployeeSchema,
  type AvailabilityInput,
  type BulkOnboardEmployeesInput,
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
import { z } from "zod";

const employeeIdParams = z.object({ employeeId: z.string().min(1) }).strict();

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
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboarding.onboardEmployee(currentUser, body);
  }

  @Post("onboard/bulk")
  @RequirePermission("hr:onboarding:manage")
  @Idempotent("hr.employees.onboard-bulk")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-bulk-onboard")
  @HttpCode(200)
  onboardBulk(
    @Body(new ZodValidationPipe(bulkOnboardEmployeesSchema)) body: BulkOnboardEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.bulkOnboarding.onboardEmployeesBulk(currentUser, body.employees);
  }

  @Get()
  @RequirePermission("hr:employees:view")
  async listEmployees(
    @Query(new ZodValidationPipe(listEmployeesSchema)) query: ListEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    const search = query.search ?? query.q;
    return this.employees.listEmployees(currentUser.orgId, currentUser.userId, {
      cursor: query.cursor,
      limit: query.limit,
      search,
      departmentId: query.departmentId,
      isActive: query.isActive,
      role: query.role,
    }, scope);
  }

  private async resolveTargetUserId(
    currentUser: CurrentUserContext,
    requested: string | undefined,
  ): Promise<string> {
    const targetUserId = requested ?? currentUser.userId;
    const scope = await resolveEmployeesScope(this.access, currentUser);
    await this.employees.assertEmployeeVisible(
      currentUser.orgId,
      currentUser.userId,
      targetUserId,
      scope,
    );
    return targetUserId;
  }

  @Get("stats")
  @RequirePermission("hr:employees:view")
  async stats(
    @Query("userId") userId: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const targetId = await this.resolveTargetUserId(currentUser, userId);
    return this.employees.getStats(currentUser.orgId, targetId);
  }

  @Get("anniversary-feed")
  @RequirePermission("hr:employees:view")
  async anniversaryFeed(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getAnniversaryFeed(currentUser.orgId, currentUser.userId, scope);
  }

  @Get("availability")
  @RequirePermission("hr:employees:view")
  async availability(
    @Query(new ZodValidationPipe(availabilitySchema)) query: AvailabilityInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getAvailability(
      currentUser.orgId,
      currentUser.userId,
      query.userIds,
      scope,
    );
  }

  @Get("check-email")
  @RequirePermission("hr:onboarding:manage")
  checkEmail(
    @Query("email") email: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (!email) throw new BadRequestException("Email is required");
    return this.employees.checkEmail(currentUser.orgId, email);
  }

  @Get("find-expert")
  @RequirePermission("hr:employees:view")
  async findExpert(
    @Query(new ZodValidationPipe(findExpertSchema)) query: FindExpertInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.skills.findExpert(currentUser.orgId, currentUser.userId, query, scope);
  }

  @Get("skills-matrix")
  @RequirePermission("hr:employees:view")
  async skillsMatrix(
    @Query(new ZodValidationPipe(skillsMatrixQuerySchema))
    query: SkillsMatrixQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.skills.getSkillsMatrix(currentUser.orgId, currentUser.userId, scope, query);
  }

  @Get("projects")
  @RequirePermission("hr:employees:view")
  async projects(
    @Query("userId") userId: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getProjects(currentUser.orgId, await this.resolveTargetUserId(currentUser, userId));
  }

  @Get("tickets")
  @RequirePermission("hr:employees:view")
  async tickets(
    @Query("userId") userId: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getTickets(currentUser.orgId, await this.resolveTargetUserId(currentUser, userId));
  }

  @Get(":employeeId/reports-to-me")
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
  @RequirePermission("hr:employees:view")
  @Validate({ params: employeeIdParams })
  async managerScorecard(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employees.getManagerScorecard(
      currentUser.orgId,
      await this.resolveTargetUserId(currentUser, employeeId),
    );
  }

  @Get(":employeeId/profile-pdf")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: employeeIdParams })
  async profilePdf(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
    @Res() res: Response,
  ) {
    const scope = await resolveEmployeesManageScope(this.access, currentUser);
    const employee = await this.mutations.getEmployeeDetail(
      currentUser.orgId,
      currentUser.userId,
      employeeId,
      scope,
    );
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
  @Validate({ params: employeeIdParams })
  async getEmployeeDetail(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    const employee = await this.mutations.getEmployeeDetail(
      currentUser.orgId,
      currentUser.userId,
      employeeId,
      scope,
    );
    if (!employee) throw new NotFoundException("Employee not found.");
    return employee;
  }

  @Patch(":employeeId")
  @RequirePermission("hr:employees:update")
  @Validate({ params: employeeIdParams })
  updateEmployee(
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.mutations.updateEmployee(currentUser, employeeId, body);
  }
}
