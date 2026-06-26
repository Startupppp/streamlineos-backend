import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AttendanceService } from "./attendance.service";
import {
  attendanceLogsQuerySchema,
  checkInSchema,
  checkOutSchema,
  heatmapQuerySchema,
  monthlyQuerySchema,
  type AttendanceLogsQuery,
  type CheckInInput,
  type CheckOutInput,
  type HeatmapQuery,
  type MonthlyQuery,
} from "./dto/attendance.schemas";

@Controller("hr/attendance")
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post("check-in")
  @HttpCode(200)
  checkIn(
    @Body(new ZodValidationPipe(checkInSchema)) body: CheckInInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.checkIn(u.orgId, u.userId, body);
  }

  @Post("check-out")
  @HttpCode(200)
  checkOut(
    @Body(new ZodValidationPipe(checkOutSchema)) body: CheckOutInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.checkOut(u.orgId, u.userId, body.localDate);
  }

  @Post("break")
  @HttpCode(200)
  toggleBreak(@CurrentUser() u: CurrentUserContext) {
    return this.attendance.toggleBreak(u.orgId, u.userId);
  }

  @Get("status")
  status(@CurrentUser() u: CurrentUserContext) {
    return this.attendance.status(u.orgId, u.userId);
  }

  @Get("logs")
  logs(
    @Query(new ZodValidationPipe(attendanceLogsQuerySchema)) query: AttendanceLogsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.logs(u, query.userId, query.year, query.month);
  }

  @Get("monthly")
  monthly(
    @Query(new ZodValidationPipe(monthlyQuerySchema)) query: MonthlyQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.monthly(u.orgId, query.userId ?? u.userId, query.year, query.month);
  }

  @Get("heatmap")
  heatmap(
    @Query(new ZodValidationPipe(heatmapQuerySchema)) query: HeatmapQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attendance.heatmap(
      u.orgId,
      query.userId ?? u.userId,
      query.year ?? new Date().getFullYear(),
    );
  }

  @Get("team-status")
  teamStatus(@CurrentUser() u: CurrentUserContext) {
    return this.attendance.teamStatus(u);
  }
}
