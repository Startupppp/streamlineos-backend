import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AttendanceService } from "./attendance.service";
import {
  attendanceEmailReportSchema,
  attendanceLogsQuerySchema,
  checkInSchema,
  checkOutSchema,
  createOrgHolidaySchema,
  heatmapQuerySchema,
  monthlyQuerySchema,
  teamStatusQuerySchema,
  updateOrgHolidaySchema,
  type AttendanceEmailReportInput,
  type AttendanceLogsQuery,
  type TeamStatusQuery,
  type CheckInInput,
  type CheckOutInput,
  type CreateOrgHolidayInput,
  type HeatmapQuery,
  type MonthlyQuery,
  type UpdateOrgHolidayInput,
} from "./dto/attendance.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const holidayIdParams = z.object({ holidayId: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/attendance")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post("check-in")
  @HttpCode(200)
  @RequirePermission("hr:attendance:view")
  @Idempotent("hr.attendance.check-in")
  checkIn(
    @Body(new ZodValidationPipe(checkInSchema)) input: CheckInInput,
    @CurrentUser() currentUser: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.attendance.checkIn(
      currentUser.orgId,
      currentUser.userId,
      input,
      idempotencyKey,
    );
  }

  @Post("check-out")
  @HttpCode(200)
  @RequirePermission("hr:attendance:view")
  @Idempotent("hr.attendance.check-out")
  checkOut(
    @Body(new ZodValidationPipe(checkOutSchema)) _validatedInput: CheckOutInput,
    @CurrentUser() currentUser: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.attendance.checkOut(
      currentUser.orgId,
      currentUser.userId,
      idempotencyKey,
    );
  }

  @Post("break")
  @HttpCode(200)
  @RequirePermission("hr:attendance:view")
  @Idempotent("hr.attendance.toggle-break")
  toggleBreak(
    @CurrentUser() currentUser: CurrentUserContext,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.attendance.toggleBreak(
      currentUser.orgId,
      currentUser.userId,
      idempotencyKey,
    );
  }

  @Get("status")
  @RequirePermission("hr:attendance:view")
  status(@CurrentUser() u: CurrentUserContext) {
    return this.attendance.status(u.orgId, u.userId);
  }

  @Get("logs")
  @RequirePermission("hr:attendance:view")
  async logs(
    @Query(new ZodValidationPipe(attendanceLogsQuerySchema)) query: AttendanceLogsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return await this.attendance.logs(u, query.userId, query.year, query.month);
  }

  @Get("monthly")
  @RequirePermission("hr:attendance:view")
  monthly(
    @Query(new ZodValidationPipe(monthlyQuerySchema)) query: MonthlyQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.monthly(u, query.userId ?? u.userId, query.year, query.month);
  }

  @Get("heatmap")
  @RequirePermission("hr:attendance:view")
  heatmap(
    @Query(new ZodValidationPipe(heatmapQuerySchema)) query: HeatmapQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.heatmap(u, query.userId ?? u.userId, query.year ?? new Date().getFullYear());
  }

  @Get("team-status")
  @RequirePermission("hr:attendance:view")
  teamStatus(
    @Query(new ZodValidationPipe(teamStatusQuerySchema)) query: TeamStatusQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.teamStatus(u, query);
  }

  @Post("email-report")
  @RequirePermission("hr:attendance:manage")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:attendance-report")
  emailReport(
    @Body(new ZodValidationPipe(attendanceEmailReportSchema)) body: AttendanceEmailReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.emailReport(u, body);
  }

  @Get("holidays")
  @RequirePermission("hr:attendance:view")
  listHolidays(@CurrentUser() u: CurrentUserContext) {
    return this.attendance.listHolidays(u.orgId);
  }

  @Post("holidays")
  @HttpCode(201)
  @RequirePermission("hr:attendance:manage")
  createHoliday(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createOrgHolidaySchema)) body: CreateOrgHolidayInput,
  ) {
    return this.attendance.createHoliday(u.orgId, u.userId, body);
  }

  @Patch("holidays/:holidayId")
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: holidayIdParams })
  updateHoliday(
    @CurrentUser() u: CurrentUserContext,
    @Param("holidayId") holidayId: string,
    @Body(new ZodValidationPipe(updateOrgHolidaySchema)) body: UpdateOrgHolidayInput,
  ) {
    return this.attendance.updateHoliday(u.orgId, holidayId, body);
  }

  @Delete("holidays/:holidayId")
  @HttpCode(204)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: holidayIdParams })
  deleteHoliday(@CurrentUser() u: CurrentUserContext, @Param("holidayId") holidayId: string) {
    return this.attendance.deleteHoliday(u.orgId, holidayId);
  }
}
