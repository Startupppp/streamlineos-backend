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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { holidaysResponseSchema } from "./dto/timesheets-response.schemas";

@RequireModule("timesheets")
@Controller("timesheets/calendar")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetCalendarController {
  constructor(private readonly reports: ReportsService) {}

  @Get("holidays")
  @RequirePermission("timesheets:entries:view")
  @ResponseSchema(holidaysResponseSchema)
  holidays(
    @Query(new ZodValidationPipe(holidayRangeQuerySchema)) query: HolidayRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getHolidays(u, query.startDate, query.endDate);
  }
}
