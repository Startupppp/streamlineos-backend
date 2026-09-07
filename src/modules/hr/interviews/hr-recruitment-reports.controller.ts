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
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  createScheduledReportSchema,
  generateReportSchema,
  type CreateScheduledReportInput,
  type GenerateReportInput,
} from "./dto/hr-interviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  generateReportResponseSchema,
  scheduledReportSchema,
  successSchema,
  recruitmentAnalyticsSchema,
  recruitmentStatsSchema,
} from "./dto/interviews-response.schemas";

const reportIdParams = z.object({ reportId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrRecruitmentReportsController {
  constructor(private readonly reports: HrRecruitmentReportsService) {}

  @Post("reports/generate")
  @HttpCode(200)
  @ResponseSchema(generateReportResponseSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: generateReportSchema })
  generateReport(
    @Body() body: GenerateReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.generateReport(u.orgId, body);
  }

  @Get("reports/scheduled")
  @ResponseSchema(z.array(scheduledReportSchema))
  @RequirePermission("hr:interviews:view")
  listScheduled(@CurrentUser() u: CurrentUserContext) {
    return this.reports.listScheduledReports(u.orgId);
  }

  @Post("reports/scheduled")
  @HttpCode(201)
  @ResponseSchema(scheduledReportSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: createScheduledReportSchema })
  createScheduled(
    @Body() body: CreateScheduledReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.createScheduledReport(u.orgId, u.userId, body);
  }

  @Delete("reports/scheduled/:reportId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: reportIdParams })
  deleteScheduled(
    @Param("reportId", ParseIntPipe) reportId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.deleteScheduledReport(u.orgId, reportId);
  }

  @Get("analytics")
  @ResponseSchema(recruitmentAnalyticsSchema)
  @RequirePermission("hr:interviews:view")
  analytics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.analytics(u.orgId);
  }

  @Get("stats")
  @ResponseSchema(recruitmentStatsSchema)
  @RequirePermission("hr:interviews:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.reports.stats(u.orgId);
  }
}
