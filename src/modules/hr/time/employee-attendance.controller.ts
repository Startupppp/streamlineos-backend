import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  checkInSchema,
  checkOutSchema,
  createAttendanceRegularizationSchema,
  selfAttendanceLogsQuerySchema,
  selfAttendanceHistoryQuerySchema,
  selfHeatmapQuerySchema,
  selfMonthlyQuerySchema,
  type CheckInInput,
  type CheckOutInput,
  type CreateAttendanceRegularizationInput,
  type SelfAttendanceLogsQuery,
  type SelfAttendanceHistoryQuery,
  type SelfHeatmapQuery,
  type SelfMonthlyQuery,
} from "./dto/attendance.schemas";
import { AttendanceService } from "./attendance.service";
import { AttendanceRegularizationService } from "./attendance-regularization.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

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
  @Idempotent("hr.attendance.check-in")
  @Validate({ body: checkInSchema })
  checkIn(
    @Body() input: CheckInInput,
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
  @Idempotent("hr.attendance.check-out")
  @Validate({ body: checkOutSchema })
  checkOut(
    @Body() _validatedInput: CheckOutInput,
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

  @Get("logs")
  @Validate({ query: selfAttendanceLogsQuerySchema })
  logs(
    @Query() query: SelfAttendanceLogsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.logs(user, undefined, query.year, query.month);
  }

  @Get("history")
  @Validate({ query: selfAttendanceHistoryQuerySchema })
  history(
    @Query() query: SelfAttendanceHistoryQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.attendance.history(
      user.orgId,
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get("monthly")
  @Validate({ query: selfMonthlyQuerySchema })
  monthly(
    @Query() query: SelfMonthlyQuery,
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
  @Validate({ query: selfHeatmapQuerySchema })
  heatmap(
    @Query() query: SelfHeatmapQuery,
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
  @Validate({ body: createAttendanceRegularizationSchema })
  createRegularization(
    @Body() body: CreateAttendanceRegularizationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.regularizations.create(user, body);
  }
}
