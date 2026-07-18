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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DashboardHrService } from "./dashboard-hr.service";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import { DashboardCrmService } from "./dashboard-crm.service";
import { DashboardProjectService } from "./dashboard-project.service";
import { isForbidden, type DashboardActor } from "./dashboard.errors";
import {
  createAnnouncementSchema,
  deleteAnnouncementSchema,
  myIssuesSchema,
  type CreateAnnouncementInput,
  type DeleteAnnouncementInput,
  type MyIssuesInput,
} from "./dto/dashboard.schemas";

@Controller("dashboard")
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(
    private readonly hr: DashboardHrService,
    private readonly leave: DashboardLeaveService,
    private readonly announcements: DashboardAnnouncementsService,
    private readonly crm: DashboardCrmService,
    private readonly project: DashboardProjectService,
  ) {}

  private toActor(u: CurrentUserContext): DashboardActor {
    return {
      userId: u.userId,
      role: u.role,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
    };
  }

  @Get("active-sprint")
  @UseGuards(ModuleGuard)
  @RequireModule("projects")
  activeSprint(@CurrentUser() u: CurrentUserContext) {
    return this.project.getActiveSprintSummary(u.orgId, u);
  }

  @Get("announcements")
  announcementsList(@CurrentUser() u: CurrentUserContext) {
    return this.announcements.getActiveAnnouncements(u.orgId);
  }

  @Post("announcements")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async createAnnouncement(
    @Body(new ZodValidationPipe(createAnnouncementSchema)) body: CreateAnnouncementInput,
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
    @Query(new ZodValidationPipe(deleteAnnouncementSchema)) query: DeleteAnnouncementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.announcements.deleteAnnouncement(u.orgId, this.toActor(u), query.id);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("birthdays")
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  birthdays(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getBirthdays(u.orgId);
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
    return this.leave.getLeavesToday(u.orgId);
  }

  @Get("my-issues")
  @UseGuards(ModuleGuard)
  @RequireModule("projects")
  myIssues(
    @Query(new ZodValidationPipe(myIssuesSchema)) query: MyIssuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.project.getMyIssues(u.orgId, u.userId);
  }

  @Get("my-leave-balance")
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
  personal(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getPersonalDashboard(u.orgId, u.userId);
  }

  @Get("recent-activity")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("projects")
  @RequirePermission("projects:tickets:view")
  recentActivity(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentActivity(u.orgId, u);
  }

  @Get("recent-projects")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("projects")
  @RequirePermission("projects:tickets:view")
  recentProjects(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentProjects(u.orgId, u);
  }

  @Get("stats")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getDashboardStats(u.orgId, u);
  }

  @Get("team-attendance")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAttendance(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getTeamAttendance(u.orgId);
  }

  @Get("team-availability")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:attendance:view")
  teamAvailability(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getTeamAvailability(u.orgId);
  }

  @Get("today-activities")
  @UseGuards(ModuleGuard, PermissionGuard)
  @RequireModule("crm")
  @RequirePermission("crm:leads:view")
  todayActivities(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getTodayActivities(u.orgId);
  }

  @Get("upcoming-holidays")
  @UseGuards(ModuleGuard)
  @RequireModule("hr")
  upcomingHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getUpcomingHolidays(u.orgId);
  }
}
