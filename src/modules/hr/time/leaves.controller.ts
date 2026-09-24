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

import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesApprovalService } from "./leaves-approval.service";
import { LeavesPageService } from "./leaves-page.service";
import {
  approveLeaveSchema,
  compOffSchema,
  createLeaveSchema,
  leaveAnalyticsQuerySchema,
  listLeaveRequestsSchema,
  listTeamLeaveRequestsSchema,
  rejectLeaveSchema,
  updateLeaveSchema,
  type ApproveLeaveInput,
  type CompOffInput,
  type CreateLeaveInput,
  type LeaveAnalyticsQuery,
  type ListLeaveRequestsQuery,
  type ListTeamLeaveRequestsQuery,
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  leaveTypeRowSchema,
  leaveBalanceRowSchema,
  leavesMyResponseSchema,
  leavesTeamResponseSchema,
  leavesThisWeekItemSchema,
  leavesAnalyticsResponseSchema,
  leavesCreateResponseSchema,
  leaveSummaryRowSchema,
  leavesPageDataSchema,
  compOffGrantResponseSchema,
  seedLeaveTypesResponseSchema,
  teamAvailabilityItemSchema,
} from "./dto/time-leave-response.schemas";

const leaveTypeIdParams = z.object({ leaveTypeId: z.coerce.number().int().positive() }).strict();
const leaveIdParams = z.object({ leaveId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(leavesPageDataSchema)
  @RequirePermission("hr:leaves:view")
  pageData(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leavesPage.pageData(currentUser.orgId, currentUser.userId);
  }

  @Get("balance")
  @ResponseSchema(z.array(leaveBalanceRowSchema))
  @RequirePermission("hr:leaves:view")
  balance(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaves.balance(currentUser.orgId, currentUser.userId);
  }

  @Get("my")
  @ResponseSchema(leavesMyResponseSchema)
  @RequirePermission("hr:leaves:view")
  @Validate({ query: listLeaveRequestsSchema })
  my(
    @Query() query: ListLeaveRequestsQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaves.my(currentUser.orgId, currentUser.userId, query);
  }

  @Get("team")
  @ResponseSchema(leavesTeamResponseSchema)
  @RequirePermission("hr:leaves:view")
  @Validate({ query: listTeamLeaveRequestsSchema })
  team(
    @Query() query: ListTeamLeaveRequestsQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaves.team(currentUser, query);
  }

  @Get("this-week")
  @ResponseSchema(z.array(leavesThisWeekItemSchema))
  @RequirePermission("hr:leaves:view")
  thisWeek(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaves.thisWeek(currentUser.orgId);
  }

  @Get("analytics")
  @ResponseSchema(leavesAnalyticsResponseSchema)
  @RequirePermission("hr:leaves:view")
  @Validate({ query: leaveAnalyticsQuerySchema })
  analytics(
    @Query() query: LeaveAnalyticsQuery,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaves.analytics(currentUser, query.year ?? new Date().getFullYear());
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(leavesCreateResponseSchema)
  @RequirePermission("hr:leaves:create")
  @Validate({ body: createLeaveSchema })
  create(
    @Body() body: CreateLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesWrite.create(currentUser, body);
  }

  @Get("types")
  @ResponseSchema(z.array(leaveTypeRowSchema))
  @RequirePermission("hr:leaves:view")
  listLeaveTypes(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaveTypes.list(currentUser.orgId);
  }

  @Post("types/seed-defaults")
  @BodylessAction()
  @ResponseSchema(seedLeaveTypesResponseSchema)
  @HttpCode(200)
  @RequirePermission("hr:leaves:manage")
  seedDefaultLeaveTypes(@CurrentUser() currentUser: CurrentUserContext) {
    return this.leaveTypes.seedDefaults(currentUser.orgId);
  }

  @Patch("types/:leaveTypeId")
  @ResponseSchema(leaveTypeRowSchema)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: leaveTypeIdParams, body: updateLeaveTypeSchema })
  updateLeaveType(
    @Param("leaveTypeId", ParseIntPipe) leaveTypeId: number,
    @Body() body: UpdateLeaveTypeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.update(currentUser.orgId, leaveTypeId, body);
  }

  @Delete("types/:leaveTypeId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: leaveTypeIdParams })
  deleteLeaveType(
    @Param("leaveTypeId", ParseIntPipe) leaveTypeId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.delete(currentUser.orgId, leaveTypeId);
  }

  @Post("types")
  @HttpCode(201)
  @ResponseSchema(leaveTypeRowSchema)
  @RequirePermission("hr:leaves:manage")
  @Validate({ body: createLeaveTypeSchema })
  createLeaveType(
    @Body() body: CreateLeaveTypeInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leaveTypes.create(currentUser.orgId, body);
  }

  @Post("comp-off")
  @HttpCode(201)
  @ResponseSchema(compOffGrantResponseSchema)
  @RequirePermission("hr:leaves:manage")
  @Validate({ body: compOffSchema })
  compOff(
    @Body() body: CompOffInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compOffGrants.grant(currentUser, body);
  }

  @Patch(":leaveId/cancel")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @RequirePermission("hr:leaves:create")
  @Validate({ params: leaveIdParams })
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
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  @Validate({ params: leaveIdParams, body: approveLeaveSchema })
  approve(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body() body: ApproveLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesApproval.approve(currentUser, leaveId, body);
  }

  @Put(":leaveId/reject")
  @Idempotent("hr.leave.reject")
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:approve")
  @Validate({ params: leaveIdParams, body: rejectLeaveSchema })
  reject(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body() body: RejectLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.leavesApproval.reject(currentUser, leaveId, body);
  }

  @Patch(":leaveId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:leaves:approve")
  @Validate({ params: leaveIdParams, body: updateLeaveSchema })
  async update(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body() body: UpdateLeaveInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const result = await this.leavesApproval.updateStatus(currentUser, leaveId, body);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Get("team-availability")
  @ResponseSchema(z.array(teamAvailabilityItemSchema))
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
  @ResponseSchema(z.array(leaveSummaryRowSchema))
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
