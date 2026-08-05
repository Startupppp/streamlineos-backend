import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  checkInSchema,
  checkOutSchema,
  createAttendanceRegularizationSchema,
  selfAttendanceLogsQuerySchema,
  selfHeatmapQuerySchema,
  selfMonthlyQuerySchema,
  type CheckInInput,
  type CheckOutInput,
  type CreateAttendanceRegularizationInput,
  type SelfAttendanceLogsQuery,
  type SelfHeatmapQuery,
  type SelfMonthlyQuery,
} from "./dto/attendance.schemas";
import { AttendanceService } from "./attendance.service";
import { AttendanceRegularizationService } from "./attendance-regularization.service";

@Controller("me/attendance")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("self:attendance")
export class EmployeeAttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly regularizations: AttendanceRegularizationService,
  ) {}

  @Get("status")
  status(@CurrentUser() user: CurrentUserContext) {
    return this.attendance.status(user.orgId, user.userId);
  }

  @Post("check-in")
  @HttpCode(200)
  checkIn(
    @Body(new ZodValidationPipe(checkInSchema)) body: CheckInInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.checkIn(user.orgId, user.userId, body);
  }

  @Post("check-out")
  @HttpCode(200)
  checkOut(
    @Body(new ZodValidationPipe(checkOutSchema)) body: CheckOutInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.checkOut(user.orgId, user.userId, body.localDate);
  }

  @Post("break")
  @HttpCode(200)
  toggleBreak(@CurrentUser() user: CurrentUserContext) {
    return this.attendance.toggleBreak(user.orgId, user.userId);
  }

  @Get("logs")
  logs(
    @Query(new ZodValidationPipe(selfAttendanceLogsQuerySchema))
    query: SelfAttendanceLogsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.logs(user, undefined, query.year, query.month);
  }

  @Get("monthly")
  monthly(
    @Query(new ZodValidationPipe(selfMonthlyQuerySchema)) query: SelfMonthlyQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.monthly(
      user,
      user.userId,
      query.year,
      query.month,
    );
  }

  @Get("heatmap")
  heatmap(
    @Query(new ZodValidationPipe(selfHeatmapQuerySchema)) query: SelfHeatmapQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.heatmap(
      user,
      user.userId,
      query.year ?? new Date().getFullYear(),
    );
  }

  @Get("holidays")
  holidays(@CurrentUser() user: CurrentUserContext) {
    return this.attendance.listHolidays(user.orgId);
  }

  @Post("regularizations")
  @HttpCode(201)
  createRegularization(
    @Body(new ZodValidationPipe(createAttendanceRegularizationSchema))
    body: CreateAttendanceRegularizationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.regularizations.create(user, body);
  }
}
