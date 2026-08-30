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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("build")
  activeSprint(@CurrentUser() u: CurrentUserContext) {
    return this.project.getActiveSprintSummary(u.orgId, u);
  }

  @Get("announcements")
  @Universal()
  announcementsList(@CurrentUser() u: CurrentUserContext) {
    return this.announcements.getActiveAnnouncements(u.orgId);
  }

  @Post("announcements")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async createAnnouncement(
    @Body(new ZodValidationPipe(createAnnouncementSchema))
    body: CreateAnnouncementInput,
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
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async deleteAnnouncement(
    @Query(new ZodValidationPipe(deleteAnnouncementSchema))
    query: DeleteAnnouncementInput,
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
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  birthdays(@CurrentUser() u: CurrentUserContext) {
    return this.birthdaysService.getBirthdays(u.orgId);
  }

  @Get("executive")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  executive(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getExecutiveDashboard(u.orgId);
  }

  @Get("leaves-today")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:leaves:view")
  leavesToday(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getLeavesToday(u);
  }

  @Get("my-issues")
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("build")
  myIssues(@CurrentUser() u: CurrentUserContext) {
    return this.project.getMyIssues(u.orgId, u.userId);
  }

  @Get("my-leave-balance")
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  myLeaveBalance(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getMyLeaveBalance(u.orgId, u.userId);
  }

  @Get("pending-approvals")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:leaves:approve")
  async pendingApprovals(@CurrentUser() u: CurrentUserContext) {
    const result = await this.leave.getPendingApprovals(u.orgId, u);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("personal")
  @Universal()
  personal(@CurrentUser() u: CurrentUserContext) {
    return this.personalService.getPersonalDashboard(u);
  }

  @Get("recent-activity")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("build")
  @RequirePermission("build:tickets:view")
  recentActivity(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentActivity(u.orgId, u);
  }

  @Get("recent-projects")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("build")
  @RequirePermission("build:tickets:view")
  recentProjects(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentProjects(u.orgId, u);
  }

  @Get("stats")
  @Universal()
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.statsService.getDashboardStats(u.orgId, u);
  }

  @Get("team-attendance")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAttendance(@CurrentUser() u: CurrentUserContext) {
    return this.availability.getTeamAttendance(u);
  }

  @Get("team-availability")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAvailability(@CurrentUser() u: CurrentUserContext) {
    return this.availability.getTeamAvailability(u);
  }

  @Get("today-activities")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("crm")
  @RequirePermission("crm:leads:view")
  todayActivities(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getTodayActivities(u.orgId);
  }

  @Get("upcoming-holidays")
  @Universal()
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  upcomingHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getUpcomingHolidays(u.orgId);
  }
}
