import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrRecruitmentReportsService } from "./hr-recruitment-reports.service";
import { AccessService } from "../access/access.service";
import {
  createScheduledReportSchema,
  generateReportSchema,
  type CreateScheduledReportInput,
  type GenerateReportInput,
} from "./dto/hr-interviews.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class HrRecruitmentReportsController {
  constructor(
    private readonly reports: HrRecruitmentReportsService,
    private readonly access: AccessService,
  ) {}

  @Post("reports/generate")
  @HttpCode(200)
  async generateReport(
    @Body(new ZodValidationPipe(generateReportSchema)) body: GenerateReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.reports.generateReport(u.orgId, body);
  }

  @Get("reports/scheduled")
  async listScheduled(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.reports.listScheduledReports(u.orgId);
  }

  @Post("reports/scheduled")
  @HttpCode(201)
  async createScheduled(
    @Body(new ZodValidationPipe(createScheduledReportSchema)) body: CreateScheduledReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.reports.createScheduledReport(u.orgId, u.userId, body);
  }

  @Delete("reports/scheduled/:reportId")
  async deleteScheduled(
    @Param("reportId", ParseIntPipe) reportId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.reports.deleteScheduledReport(u.orgId, reportId);
  }

  @Get("analytics")
  analytics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.analytics(u.orgId);
  }

  @Get("stats")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.reports.stats(u.orgId);
  }
}
