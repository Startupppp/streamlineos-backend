import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { FinanceReportExportService } from "./finance-report-export.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import { createFinanceReportExportJobSchema, finReportExportJobIdParams } from "./dto/finance-report-export.schemas";
import type { CreateFinanceReportExportJobInput } from "./dto/finance-report-export.schemas";
import { exportJobSchema } from "./dto/finance-reports-export-response.schemas";

@RequireModule("accounting")
@Controller("accounting/reports/export")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FinanceReportExportController {
  constructor(private readonly exportJobs: FinanceReportExportService) {}

  @Post("jobs")
  @ResponseSchema(exportJobSchema)
  @HttpCode(202)
  @Idempotent("accounting.reports.export.create")
  @RequirePermission("accounting:reports:export")
  @Validate({ body: createFinanceReportExportJobSchema })
  async createJob(
    @Body() body: CreateFinanceReportExportJobInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportJobs.create(u, body, idempotencyKey);
  }

  @Get("jobs/:jobId")
  @ResponseSchema(exportJobSchema)
  @RequirePermission("accounting:reports:export")
  @Validate({ params: finReportExportJobIdParams })
  getJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext) {
    return this.exportJobs.get(u, jobId);
  }

  @Post("jobs/:jobId/cancel")
  @ResponseSchema(exportJobSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("accounting:reports:export")
  @Validate({ params: finReportExportJobIdParams })
  cancelJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext) {
    return this.exportJobs.cancel(u, jobId);
  }

  @Get("jobs/:jobId/download")
  @ApiOkResponse({ content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } })
  @RequirePermission("accounting:reports:export")
  @Validate({ params: finReportExportJobIdParams })
  async downloadJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const { job, file } = await this.exportJobs.download(u, jobId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${(job.fileName ?? "report.csv").replace(/[^a-zA-Z0-9_.-]/g, "-")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) res.setHeader("Content-Length", String(file.contentLength));
    await pipeline(file.body, res);
  }
}
