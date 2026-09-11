import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  dashboardAnnouncementsResponseSchema,
  dashboardPersonalResponseSchema,
  dashboardStatsResponseSchema,
} from "./dto/dashboard-response-schema";
import {
  announcementCreateSchema,
  announcementDeleteSchema,
  birthdayEntrySchema,
  executiveDashboardSchema,
  pendingApprovalsSchema,
  recentActivitySchema,
  teamAttendanceSchema,
  teamAvailabilitySchema,
  todayActivitiesSchema,
} from "./dto/dashboard-misc-response.schemas";
import { leavesTodaySchema, myLeaveBalanceSchema } from "../hr/time/dto/time-leave-response.schemas";
import { upcomingHolidaysSchema } from "../hr/time/dto/time-attendance-response.schemas";
import { myIssuesSchema } from "../build/core/dto/build-tickets-response.schemas";
import { activeSprintSchema } from "../build/execution/dto/execution-response.schemas";
import { recentProjectsSchema } from "../build/core/dto/build-core-response.schemas";
import { DashboardStatsService } from "./dashboard-stats.service";
import { DashboardAvailabilityService } from "./dashboard-availability.service";
import { DashboardBirthdaysService } from "./dashboard-birthdays.service";
import { DashboardPersonalService } from "./dashboard-personal.service";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import { DashboardCrmService } from "./dashboard-crm.service";
import { DashboardProjectService } from "./dashboard-project.service";
import { isForbidden, type DashboardActor } from "./dashboard.errors";
import {
  createAnnouncementSchema,
  deleteAnnouncementSchema,
  type CreateAnnouncementInput,
  type DeleteAnnouncementInput,
} from "./dto/dashboard.schemas";

@Controller("dashboard")
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(
    private readonly statsService: DashboardStatsService,
    private readonly availability: DashboardAvailabilityService,
    private readonly birthdaysService: DashboardBirthdaysService,
    private readonly personalService: DashboardPersonalService,
    private readonly leave: DashboardLeaveService,
    private readonly announcements: DashboardAnnouncementsService,
    private readonly crm: DashboardCrmService,
    private readonly project: DashboardProjectService,
  ) {}

  private toActor(u: CurrentUserContext): DashboardActor {
    return u;
  }

  @Get("active-sprint")
  @ResponseSchema(activeSprintSchema)
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("build")
  activeSprint(@CurrentUser() u: CurrentUserContext) {
    return this.project.getActiveSprintSummary(u.orgId, u);
  }

  @Get("announcements")
  @ResponseSchema(dashboardAnnouncementsResponseSchema)
  @Universal()
  announcementsList(@CurrentUser() u: CurrentUserContext) {
    return this.announcements.getActiveAnnouncements(u.orgId);
  }

  @Post("announcements")
  @ResponseSchema(announcementCreateSchema)
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: createAnnouncementSchema })
  async createAnnouncement(
    @Body() body: CreateAnnouncementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.announcements.createAnnouncement(
      u.orgId,
      u.userId,
      this.toActor(u),
      body,
    );
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Delete("announcements")
  @ResponseSchema(announcementDeleteSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ query: deleteAnnouncementSchema })
  async deleteAnnouncement(
    @Query() query: DeleteAnnouncementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.announcements.deleteAnnouncement(
      u.orgId,
      this.toActor(u),
      query.id,
    );
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("birthdays")
  @ResponseSchema(birthdayEntrySchema)
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  birthdays(@CurrentUser() u: CurrentUserContext) {
    return this.birthdaysService.getBirthdays(u.orgId);
  }

  @Get("executive")
  @ResponseSchema(executiveDashboardSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  executive(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getExecutiveDashboard(u);
  }

  @Get("leaves-today")
  @ResponseSchema(leavesTodaySchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:leaves:view")
  leavesToday(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getLeavesToday(u);
  }

  @Get("my-issues")
  @ResponseSchema(myIssuesSchema)
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("build")
  myIssues(@CurrentUser() u: CurrentUserContext) {
    return this.project.getMyIssues(u.orgId, u.userId);
  }

  @Get("my-leave-balance")
  @ResponseSchema(myLeaveBalanceSchema)
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  myLeaveBalance(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getMyLeaveBalance(u);
  }

  @Get("pending-approvals")
  @ResponseSchema(pendingApprovalsSchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:leaves:approve")
  async pendingApprovals(@CurrentUser() u: CurrentUserContext) {
    const result = await this.leave.getPendingApprovals(u.orgId, u);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("personal")
  @ResponseSchema(dashboardPersonalResponseSchema)
  @Universal()
  personal(@CurrentUser() u: CurrentUserContext) {
    return this.personalService.getPersonalDashboard(u);
  }

  @Get("recent-activity")
  @ResponseSchema(recentActivitySchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("build")
  @RequirePermission("build:tickets:view")
  recentActivity(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentActivity(u.orgId, u);
  }

  @Get("recent-projects")
  @ResponseSchema(recentProjectsSchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("build")
  @RequirePermission("build:tickets:view")
  recentProjects(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentProjects(u.orgId, u);
  }

  @Get("stats")
  @ResponseSchema(dashboardStatsResponseSchema)
  @Universal()
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.statsService.getDashboardStats(u.orgId, u);
  }

  @Get("team-attendance")
  @ResponseSchema(teamAttendanceSchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAttendance(@CurrentUser() u: CurrentUserContext) {
    return this.availability.getTeamAttendance(u);
  }

  @Get("team-availability")
  @ResponseSchema(teamAvailabilitySchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAvailability(@CurrentUser() u: CurrentUserContext) {
    return this.availability.getTeamAvailability(u);
  }

  @Get("today-activities")
  @ResponseSchema(todayActivitiesSchema)
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("crm")
  @RequirePermission("crm:leads:view")
  todayActivities(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getTodayActivities(u.orgId);
  }

  @Get("upcoming-holidays")
  @ResponseSchema(upcomingHolidaysSchema)
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  upcomingHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getUpcomingHolidays(u.orgId);
  }
}
