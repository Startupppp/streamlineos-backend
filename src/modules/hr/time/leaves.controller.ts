import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesApprovalService } from "./leaves-approval.service";
import { LeavesPageService } from "./leaves-page.service";
import {
  approveLeaveSchema,
  compOffSchema,
  createLeaveSchema,
  leaveAnalyticsQuerySchema,
  leaveCalendarQuerySchema,
  listLeaveRequestsSchema,
  rejectLeaveSchema,
  updateLeaveSchema,
  type ApproveLeaveInput,
  type CompOffInput,
  type CreateLeaveInput,
  type LeaveAnalyticsQuery,
  type LeaveCalendarQuery,
  type ListLeaveRequestsQuery,
  type RejectLeaveInput,
  type UpdateLeaveInput,
  createLeaveTypeSchema,
  type CreateLeaveTypeInput,
  updateLeaveTypeSchema,
  type UpdateLeaveTypeInput,
} from "./dto/leaves.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CompOffGrantService } from "./comp-off-grant.service";
import { LeaveTypesService } from "./leave-types.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

@RequireModule("hr")
@Controller("hr/leaves")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeavesController {
  constructor(
    private readonly leaves: LeavesService,
    private readonly leavesWrite: LeavesWriteService,
    private readonly leavesApproval: LeavesApprovalService,
    private readonly leavesPage: LeavesPageService,
    private readonly compOffGrants: CompOffGrantService,
    private readonly leaveTypes: LeaveTypesService,
  ) {}

  @Get()
  @RequirePermission("hr:leaves:view")
  pageData(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leavesPage.pageData(currentUser.orgId, currentUser.userId);
  }

  @Get("balance")
  @RequirePermission("hr:leaves:view")
  balance(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaves.balance(currentUser.orgId, currentUser.userId);
  }

  @Get("my")
  @RequirePermission("hr:leaves:view")
  my(
    @Query(new ZodValidationPipe(listLeaveRequestsSchema))
    query: ListLeaveRequestsQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaves.my(currentUser.orgId, currentUser.userId, query);
  }

  @Get("team")
  @RequirePermission("hr:leaves:view")
  async team(@CurrentUser() currentUser: CurrentUserContext) {
    return await this.leaves.team(currentUser);
  }

  @Get("this-week")
  @RequirePermission("hr:leaves:view")
  thisWeek(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaves.thisWeek(currentUser.orgId);
  }

  @Get("analytics")
  @RequirePermission("hr:leaves:view")
  analytics(
    @Query(new ZodValidationPipe(leaveAnalyticsQuerySchema)) query: LeaveAnalyticsQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaves.analytics(currentUser, query.year ?? new Date().getFullYear());
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:leaves:create")
  create(
    @Body(new ZodValidationPipe(createLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesWrite.create(currentUser, body);
  }

  @Get("types")
  @RequirePermission("hr:leaves:view")
  listLeaveTypes(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaveTypes.list(currentUser.orgId);
  }

  @Post("types/seed-defaults")
  @HttpCode(200)
  @RequirePermission("hr:leaves:manage")
  seedDefaultLeaveTypes(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaveTypes.seedDefaults(currentUser.orgId);
  }

  @Patch("types/:leaveTypeId")
  @RequirePermission("hr:leaves:manage")
  updateLeaveType(
    @Param("leaveTypeId", ParseIntPipe) leaveTypeId: number,
    @Body(new ZodValidationPipe(updateLeaveTypeSchema)) body: UpdateLeaveTypeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.update(currentUser.orgId, leaveTypeId, body);
  }

  @Delete("types/:leaveTypeId")
  @RequirePermission("hr:leaves:manage")
  deleteLeaveType(
    @Param("leaveTypeId", ParseIntPipe) leaveTypeId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.delete(currentUser.orgId, leaveTypeId);
  }

  @Post("types")
  @HttpCode(201)
  @RequirePermission("hr:leaves:manage")
  createLeaveType(
    @Body(new ZodValidationPipe(createLeaveTypeSchema)) body: CreateLeaveTypeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.create(currentUser.orgId, body);
  }

  @Post("comp-off")
  @HttpCode(201)
  @RequirePermission("hr:leaves:manage")
  compOff(
    @Body(new ZodValidationPipe(compOffSchema)) body: CompOffInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compOffGrants.grant(currentUser, body);
  }

  @Patch(":leaveId/cancel")
  @RequirePermission("hr:leaves:create")
  async cancel(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.cancel(currentUser, leaveId);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Put(":leaveId/approve")
  @Idempotent("hr.leave.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  approve(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(approveLeaveSchema)) body: ApproveLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesApproval.approve(currentUser, leaveId, body);
  }

  @Put(":leaveId/reject")
  @Idempotent("hr.leave.reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  reject(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(rejectLeaveSchema)) body: RejectLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesApproval.reject(currentUser, leaveId, body);
  }

  @Patch(":leaveId")
  @RequirePermission("hr:leaves:approve")
  async update(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(updateLeaveSchema)) body: UpdateLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const result = await this.leavesApproval.updateStatus(currentUser, leaveId, body);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Get("team-availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:read")
  teamAvailability(
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException("startDate and endDate are required");
    }
    return this.leaves.teamAvailability(currentUser.orgId, startDate, endDate);
  }

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:read")
  summary(
    @Query("periodStart") periodStart: string,
    @Query("periodEnd") periodEnd: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (!periodStart || !periodEnd) {
      throw new BadRequestException("periodStart and periodEnd are required");
    }
    return this.leaves.leaveSummary(currentUser.orgId, periodStart, periodEnd);
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
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const now = new Date();
    const month = query.month ?? now.getMonth() + 1;
    const year = query.year ?? now.getFullYear();
    if (month < 1 || month > 12) {
      throw new BadRequestException("month must be between 1 and 12");
    }
    return this.leaves.calendar(currentUser.orgId, month, year);
  }
}
