import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ReportsService } from "./reports.service";
import { holidayRangeQuerySchema, type HolidayRangeQuery } from "./dto/reports.schemas";

/**
 * Calendar context for the week grid.
 *
 * A separate controller for one route, because of the permission. The obvious
 * home was `ReportsController`, which requires `timesheets:reports:view` — a
 * key the people who actually fill in a timesheet do not hold. Putting it
 * there would have shipped an endpoint the grid could never call, and it would
 * have looked finished.
 */
@RequireModule("build")
@Controller("timesheets/calendar")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetCalendarController {
  constructor(private readonly reports: ReportsService) {}

  @Get("holidays")
  @RequirePermission("timesheets:entries:view")
  holidays(
    @Query(new ZodValidationPipe(holidayRangeQuerySchema)) query: HolidayRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getHolidays(u, query.startDate, query.endDate);
  }
}
