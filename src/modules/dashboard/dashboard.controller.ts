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
  activeSprint(@CurrentUser() u: CurrentUserContext) {
    return this.project.getActiveSprintSummary(u.orgId, this.toActor(u));
  }

  @Get("announcements")
  announcementsList(@CurrentUser() u: CurrentUserContext) {
    return this.announcements.getActiveAnnouncements(u.orgId);
  }

  @Post("announcements")
  @HttpCode(201)
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
  async deleteAnnouncement(
    @Query(new ZodValidationPipe(deleteAnnouncementSchema)) query: DeleteAnnouncementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.announcements.deleteAnnouncement(u.orgId, this.toActor(u), query.id);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("birthdays")
  birthdays(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getBirthdays(u.orgId);
  }

  @Get("branch-overview")
  async branchOverview(@CurrentUser() u: CurrentUserContext) {
    const result = await this.crm.getBranchOverview(u.orgId, this.toActor(u));
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("executive")
  async executive(@CurrentUser() u: CurrentUserContext) {
    const result = await this.crm.getExecutiveDashboard(u.orgId, this.toActor(u));
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("leaves-today")
  leavesToday(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getLeavesToday(u.orgId);
  }

  @Get("manager")
  manager(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getManagerDashboard(u.orgId, u.userId);
  }

  @Get("my-issues")
  myIssues(
    @Query(new ZodValidationPipe(myIssuesSchema)) query: MyIssuesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.project.getMyIssues(u.orgId, query.userId);
  }

  @Get("my-leave-balance")
  myLeaveBalance(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getMyLeaveBalance(u.orgId, u.userId);
  }

  @Get("pending-approvals")
  async pendingApprovals(@CurrentUser() u: CurrentUserContext) {
    const result = await this.leave.getPendingApprovals(u.orgId, this.toActor(u));
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("pending-requests")
  pendingRequests(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getPendingRequests(u.orgId, u.userId);
  }

  @Get("personal")
  personal(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getPersonalDashboard(u.orgId, u.userId);
  }

  @Get("recent-activity")
  recentActivity(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentActivity(u.orgId, this.toActor(u));
  }

  @Get("recent-projects")
  recentProjects(@CurrentUser() u: CurrentUserContext) {
    return this.project.getRecentProjects(u.orgId, this.toActor(u));
  }

  @Get("role-stats")
  roleStats(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getRoleStats(u.orgId);
  }

  @Get("stats")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getDashboardStats(u.orgId);
  }

  @Get("team-attendance")
  teamAttendance(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getTeamAttendance(u.orgId);
  }

  @Get("team-availability")
  teamAvailability(@CurrentUser() u: CurrentUserContext) {
    return this.hr.getTeamAvailability(u.orgId);
  }

  @Get("today-activities")
  todayActivities(@CurrentUser() u: CurrentUserContext) {
    return this.crm.getTodayActivities(u.orgId);
  }

  @Get("upcoming-holidays")
  upcomingHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getUpcomingHolidays(u.orgId);
  }

  @Get("upcoming-leaves")
  upcomingLeaves(@CurrentUser() u: CurrentUserContext) {
    return this.leave.getUpcomingLeaves(u.orgId);
  }
}
