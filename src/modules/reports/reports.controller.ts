import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReportsService, isBadRequest, isForbidden } from "./reports.service";
import {
  attendanceReportSchema,
  payrollReportSchema,
  projectReportSchema,
  teamPerformanceReportSchema,
  type AttendanceReportInput,
  type PayrollReportInput,
  type ProjectReportInput,
  type TeamPerformanceReportInput,
} from "./dto/report.schemas";

@Controller("reports")
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("attendance")
  async attendance(
    @Query(new ZodValidationPipe(attendanceReportSchema)) query: AttendanceReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.reports.getAttendanceReport(u.orgId, u, query);
    if (isBadRequest(result)) throw new BadRequestException(result.message);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("payroll")
  async payroll(
    @Query(new ZodValidationPipe(payrollReportSchema)) query: PayrollReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.reports.getPayrollReport(u.orgId, u, query);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("project")
  project(
    @Query(new ZodValidationPipe(projectReportSchema)) query: ProjectReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getProjectReport(u.orgId, query);
  }

  @Get("team-performance")
  async teamPerformance(
    @Query(new ZodValidationPipe(teamPerformanceReportSchema)) query: TeamPerformanceReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.reports.getTeamPerformanceReport(u.orgId, query);
    if (isBadRequest(result)) throw new BadRequestException(result.message);
    return result;
  }

  @Get("source-effectiveness")
  sourceEffectiveness(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSourceEffectiveness(u.orgId);
  }
}
