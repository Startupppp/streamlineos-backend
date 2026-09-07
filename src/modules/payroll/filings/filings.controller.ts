import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollFilingsService } from "./filings.service";
import { PayrollFilingsExportJobService } from "./filings-export-job.service";
import { PayrollJobsWorkerService } from "../jobs/payroll-jobs-worker.service";
import {
  prepareFilingSchema,
  type PrepareFilingInput,
  attachAcknowledgementSchema,
  type AttachAcknowledgementInput,
  listFilingsQuerySchema,
  type ListFilingsQuery,
} from "./dto/filings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  payrollFilingListResponseSchema,
  payrollFilingSchema,
  filingExportJobViewSchema,
  listForm16EmployeesResponseSchema,
  filingCapabilitiesResponseSchema,
  payrollFilingDetailSchema,
} from "./dto/filings-response.schemas";
import { z } from "zod";

const filingIdParams = z.object({ filingId: z.coerce.number().int().positive() }).strict();
const exportJobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();
const filingIduserIdParams = z.object({ filingId: z.coerce.number().int().positive(), userId: z.string().min(1) }).strict();

@RequireModule("payroll")
@Controller("payroll/filings")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollFilingsController {
  constructor(
    private readonly service: PayrollFilingsService,
    private readonly exportJobs: PayrollFilingsExportJobService,
    private readonly jobsWorker: PayrollJobsWorkerService,
  ) {}

  @Get()
  @RequirePermission("payroll:tax:view")
  @Validate({ query: listFilingsQuerySchema })
  @ResponseSchema(payrollFilingListResponseSchema)
  list(@CurrentUser() u: CurrentUserContext, @Query() query: ListFilingsQuery) {
    return this.service.list(u.orgId, query.cursor, query.limit);
  }

  @Get("capabilities")
  @RequirePermission("payroll:tax:view")
  @ResponseSchema(filingCapabilitiesResponseSchema)
  capabilities() {
    return this.service.capabilities();
  }

  @Get("export/jobs/:jobId")
  @RequirePermission("payroll:tax:view")
  @Validate({ params: exportJobIdParams })
  @ResponseSchema(filingExportJobViewSchema)
  getExportJob(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.exportJobs.getExportJob(u.orgId, jobId);
  }

  @Get(":filingId/export")
  @RequirePermission("payroll:tax:view")
  @Validate({ params: filingIdParams })
  @ApiOkResponse({ description: "CSV filing export", content: { "text/csv": { schema: { type: "string" } } } })
  async downloadExport(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Res() res: Response,
  ) {
    const file = await this.service.getExportCsv(u.orgId, filingId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.body);
  }

  @Get(":filingId/form16/employees")
  @RequirePermission("payroll:tax:view")
  @Validate({ params: filingIdParams })
  @ResponseSchema(listForm16EmployeesResponseSchema)
  listForm16Employees(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
  ) {
    return this.service.listForm16Employees(u.orgId, filingId);
  }

  @Get(":filingId/form16/:userId")
  @RequirePermission("payroll:tax:view")
  @Validate({ params: filingIduserIdParams })
  @ApiOkResponse({ description: "Form 16 PDF certificate", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  async downloadForm16Pdf(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Param("userId") userId: string,
    @Res() res: Response,
  ) {
    const file = await this.service.getForm16CertificatePdf(
      u.orgId,
      filingId,
      userId,
    );
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.body);
  }

  @Get(":filingId")
  @RequirePermission("payroll:tax:view")
  @ResponseSchema(payrollFilingDetailSchema)
  @Validate({ params: filingIdParams })
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
  ) {
    return this.service.get(u.orgId, filingId);
  }

  @Post("export")
  @HttpCode(202)
  @RequirePermission("payroll:tax:manage")
  @Validate({ body: prepareFilingSchema })
  @ResponseSchema(filingExportJobViewSchema)
  async prepare(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: PrepareFilingInput,
  ) {
    const job = await this.exportJobs.requestExport(u.orgId, u.userId, body);
    void this.jobsWorker.flush(5);
    return job;
  }

  @Patch(":filingId/acknowledgement")
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: filingIdParams, body: attachAcknowledgementSchema })
  @ResponseSchema(payrollFilingSchema)
  ack(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Body() body: AttachAcknowledgementInput,
  ) {
    return this.service.attachAcknowledgement(u.orgId, filingId, body);
  }
}
