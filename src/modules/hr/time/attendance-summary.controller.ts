import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AttendanceSummaryService } from "./attendance-summary.service";
import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";
import { Validate } from "../../../common/validation/validate.decorator";

const attendanceSummaryQuerySchema = z
  .object({
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    employeeId: z.string().optional(),
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();

@RequireModule("hr")
@Controller("hr/attendance/summary")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:attendance:view")
export class AttendanceSummaryController {
  constructor(private readonly summaryService: AttendanceSummaryService) {}

  @Get()
  @Validate({ query: attendanceSummaryQuerySchema })
  getSummary(
    @Query() query: z.infer<typeof attendanceSummaryQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.summaryService.buildScopedAttendanceSummary(u, {
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      employeeId: query.employeeId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
