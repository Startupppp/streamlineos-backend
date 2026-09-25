import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
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
  resolveEmployeesScope,
} from "./employees-scope";
import {
  availabilitySchema,
  bulkOnboardEmployeesSchema,
  employeeIdParamsSchema,
  countEmployeesSchema,
  employeeUserQuerySchema,
  findExpertSchema,
  listEmployeesSchema,
  onboardEmployeeSchema,
  skillsMatrixQuerySchema,
  type AvailabilityInput,
  type BulkOnboardEmployeesInput,
  type CountEmployeesInput,
  type EmployeeUserQueryInput,
  type FindExpertInput,
  type ListEmployeesInput,
  type OnboardEmployeeInput,
  type SkillsMatrixQueryInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  onboardResponseSchema,
  inviteLinkSchema,
  resendInviteResponseSchema,
  employeeListPageSchema,
  employeeCountsSchema,
  employeeStatsSchema,
  anniversaryFeedSchema,
  availabilityListSchema,
  checkEmailSchema,
  findExpertResponseSchema,
  skillsMatrixSchema,
  employeeProjectsSchema,
  employeeTicketsSchema,
} from "./dto/directory-response.schemas";
import { bulkOnboardCommitResultSchema, bulkOnboardPreviewSchema } from "./dto/reporting-lines-bulk.schemas";

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
  @Idempotent("hr.employees.onboard")
  @HttpCode(201)
  @Validate({ body: onboardEmployeeSchema })
  onboard(
    @Body() body: OnboardEmployeeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboarding.onboardEmployee(currentUser, body);
  }

  @Post(":employeeId/resend-invite")
  @ResponseSchema(resendInviteResponseSchema)
  @RequirePermission("hr:onboarding:manage")
  // V-030: invite-link below has been limited since it mints a credential.
  // This route mints the same credential and mails it, and had no limiter.
  @UseRateLimit("hr:employee-resend-invite")
  @Idempotent("hr.employees.resend-invite")
  @HttpCode(200)
  @Validate({ params: employeeIdParamsSchema })
  @BodylessAction()
  resendInvite(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboarding.resendInvite(currentUser, employeeId);
  }

  @Post(":employeeId/invite-link")
  @ResponseSchema(inviteLinkSchema)
  @RequirePermission("hr:onboarding:manage")
  @UseRateLimit("hr:employee-invite-link")
  @HttpCode(200)
  @Validate({ params: employeeIdParamsSchema })
  @BodylessAction()
  createInviteLink(
    @Param("employeeId") employeeId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboarding.createInviteLink(currentUser, employeeId);
  }

  @Post("onboard/bulk/preview")
  @ResponseSchema(bulkOnboardPreviewSchema)
  @RequirePermission("hr:onboarding:manage")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-bulk-onboard-preview")
  @HttpCode(200)
  @Validate({ body: bulkOnboardEmployeesSchema })
  previewBulk(
    @Body() body: BulkOnboardEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.bulkOnboarding.previewEmployeesBulk(currentUser, body.employees);
  }

  @Post("onboard/bulk")
  @ResponseSchema(bulkOnboardCommitResultSchema)
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

  @Get("counts")
  @ResponseSchema(employeeCountsSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: countEmployeesSchema })
  async countEmployees(
    @Query() query: CountEmployeesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.employees.countEmployees(read, {
      search: query.search ?? query.q,
      departmentId: query.departmentId,
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
}
