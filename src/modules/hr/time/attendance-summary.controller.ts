import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AttendanceSummaryService } from "./attendance-summary.service";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

const attendanceSummaryQuerySchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});

@RequireModule("hr")
@Controller("hr/attendance/summary")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:attendance:view")
export class AttendanceSummaryController {
  constructor(private readonly summaryService: AttendanceSummaryService) {}

  @Get()
  getSummary(
    @Query(new ZodValidationPipe(attendanceSummaryQuerySchema)) query: z.infer<typeof attendanceSummaryQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.summaryService.buildScopedAttendanceSummary(u, {
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      employeeId: query.employeeId,
      page: query.page,
      limit: query.limit,
    });
  }
}
