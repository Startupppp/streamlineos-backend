import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  createScheduledReportSchema,
  generateReportSchema,
  type CreateScheduledReportInput,
  type GenerateReportInput,
} from "./dto/hr-interviews.schemas";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrRecruitmentReportsController {
  constructor(private readonly reports: HrRecruitmentReportsService) {}

  @Post("reports/generate")
  @HttpCode(200)
  @RequirePermission("hr:interviews:manage")
  generateReport(
    @Body(new ZodValidationPipe(generateReportSchema)) body: GenerateReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.generateReport(u.orgId, body);
  }

  @Get("reports/scheduled")
  @RequirePermission("hr:interviews:view")
  listScheduled(@CurrentUser() u: CurrentUserContext) {
    return this.reports.listScheduledReports(u.orgId);
  }

  @Post("reports/scheduled")
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  createScheduled(
    @Body(new ZodValidationPipe(createScheduledReportSchema)) body: CreateScheduledReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.createScheduledReport(u.orgId, u.userId, body);
  }

  @Delete("reports/scheduled/:reportId")
  @RequirePermission("hr:interviews:manage")
  deleteScheduled(
    @Param("reportId", ParseIntPipe) reportId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.deleteScheduledReport(u.orgId, reportId);
  }

  @Get("analytics")
  @RequirePermission("hr:interviews:view")
  analytics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.analytics(u.orgId);
  }

  @Get("stats")
  @RequirePermission("hr:interviews:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.reports.stats(u.orgId);
  }
}
