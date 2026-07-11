import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesPageService } from "./leaves-page.service";
import {
  approveLeaveSchema,
  compOffSchema,
  createLeaveSchema,
  leaveAnalyticsQuerySchema,
  leaveCalendarQuerySchema,
  rejectLeaveSchema,
  updateLeaveSchema,
  type ApproveLeaveInput,
  type CompOffInput,
  type CreateLeaveInput,
  type LeaveAnalyticsQuery,
  type LeaveCalendarQuery,
  type RejectLeaveInput,
  type UpdateLeaveInput,
} from "./dto/leaves.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/leaves")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeavesController {
  constructor(
    private readonly leaves: LeavesService,
    private readonly leavesWrite: LeavesWriteService,
    private readonly leavesPage: LeavesPageService,
  ) {}

  @Get()
  @RequirePermission("hr:leaves:view")
  pageData(@CurrentUser() u: CurrentUserContext) {
    return this.leavesPage.pageData(u.orgId, u.userId);
  }

  @Get("balance")
  @RequirePermission("hr:leaves:view")
  balance(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.balance(u.orgId, u.userId);
  }

  @Get("my")
  @RequirePermission("hr:leaves:view")
  my(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.my(u.orgId, u.userId);
  }

  @Get("team")
  @RequirePermission("hr:leaves:view")
  async team(@CurrentUser() u: CurrentUserContext) {
    return await this.leaves.team(u);
  }

  @Get("this-week")
  @RequirePermission("hr:leaves:view")
  thisWeek(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.thisWeek(u.orgId);
  }

  @Get("analytics")
  @RequirePermission("hr:leaves:view")
  analytics(
    @Query(new ZodValidationPipe(leaveAnalyticsQuerySchema)) query: LeaveAnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leaves.analytics(u, query.year ?? new Date().getFullYear());
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:leaves:view")
  create(
    @Body(new ZodValidationPipe(createLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leavesWrite.create(u, body);
  }

  @Post("comp-off")
  @HttpCode(201)
  @RequirePermission("hr:leaves:view")
  compOff(
    @Body(new ZodValidationPipe(compOffSchema)) body: CompOffInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leaves.compOff(u, body);
  }

  @Patch(":leaveId/cancel")
  @RequirePermission("hr:leaves:view")
  async cancel(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.cancel(u, leaveId);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Put(":leaveId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  approve(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(approveLeaveSchema)) body: ApproveLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leavesWrite.approve(u, leaveId, body);
  }

  @Put(":leaveId/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  reject(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(rejectLeaveSchema)) body: RejectLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leavesWrite.reject(u, leaveId, body);
  }

  @Patch(":leaveId")
  @RequirePermission("hr:leaves:view")
  async update(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(updateLeaveSchema)) body: UpdateLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.updateStatus(u, leaveId, body);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Get("team-availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:read")
  teamAvailability(
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException("startDate and endDate are required");
    }
    return this.leaves.teamAvailability(u.orgId, startDate, endDate);
  }

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:read")
  summary(
    @Query("periodStart") periodStart: string,
    @Query("periodEnd") periodEnd: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!periodStart || !periodEnd) {
      throw new BadRequestException("periodStart and periodEnd are required");
    }
    return this.leaves.leaveSummary(u.orgId, periodStart, periodEnd);
  }
}

@Controller("hr/leave-calendar")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeaveCalendarController {
  constructor(private readonly leaves: LeavesService) {}

  @Get()
  @RequirePermission("hr:leaves:read")
  calendar(
    @Query(new ZodValidationPipe(leaveCalendarQuerySchema)) query: LeaveCalendarQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const now = new Date();
    const month = query.month ?? now.getMonth() + 1;
    const year = query.year ?? now.getFullYear();
    if (month < 1 || month > 12) {
      throw new BadRequestException("month must be between 1 and 12");
    }
    return this.leaves.calendar(u.orgId, month, year);
  }
}
