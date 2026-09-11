import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import { payrollRunExportJobSchema } from "./dto/profiles-response.schemas";
import { PayrollRunExportService } from "./payroll-export.service";
import { PayrollRunExportWorkerService } from "./payroll-export-worker.service";
import { exportRunsQuerySchema, type ExportRunsQuery } from "./dto/runs.schemas";

const jobIdParams = z.object({ jobId: z.string().uuid() }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/export")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollExportController {
  constructor(
    private readonly exportJobs: PayrollRunExportService,
    private readonly exportWorker: PayrollRunExportWorkerService,
  ) {}

  @Post("jobs")
  @BodylessAction()
  @HttpCode(202)
  @Idempotent("payroll.runs.export.create")
  @RequirePermission("payroll:reports:export")
  @Validate({ query: exportRunsQuerySchema })
  @ResponseSchema(payrollRunExportJobSchema)
  async createExportJob(
    @Query() filters: ExportRunsQuery,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey?.trim()) throw new BadRequestException("Idempotency-Key header is required");
    const job = await this.exportJobs.create(u, filters, idempotencyKey.trim());
    this.exportWorker.wake();
    return job;
  }

  @Get("jobs/:jobId")
  @RequirePermission("payroll:reports:export")
  @Validate({ params: jobIdParams })
  @ResponseSchema(payrollRunExportJobSchema)
  getExportJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportJobs.get(u, jobId);
  }

  @Post("jobs/:jobId/cancel")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:reports:export")
  @Validate({ params: jobIdParams })
  @ResponseSchema(payrollRunExportJobSchema)
  cancelExportJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportJobs.cancel(u, jobId);
  }

  @Get("jobs/:jobId/download")
  @RequirePermission("payroll:reports:export")
  @Validate({ params: jobIdParams })
  @ApiOkResponse({ description: "Binary file download", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } })
  async downloadExportJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const { job, file } = await this.exportJobs.download(u, jobId);
    if (!job) throw new NotFoundException("Payroll export job not found");
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(job.fileName ?? "payroll-runs.csv").replace(/[^a-zA-Z0-9_.-]/g, "-")}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) res.setHeader("Content-Length", String(file.contentLength));
    await pipeline(file.body, res);
  }
}
