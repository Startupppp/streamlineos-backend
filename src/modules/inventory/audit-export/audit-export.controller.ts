import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AuditExportService } from "./audit-export.service";
import {
  createAuditExportJobSchema,
  listAuditExportJobsQuerySchema,
  type CreateAuditExportJobInput,
  type ListAuditExportJobsQueryInput,
} from "./dto/audit-export.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  auditExportJobResponseSchema,
  createAuditExportJobResponseSchema,
  listAuditExportJobsResponseSchema,
  verifyAuditExportResponseSchema,
} from "./dto/audit-export-response.schemas";

@RequireModule("inventory")
@Controller("inventory/audit-export")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class AuditExportController {
  constructor(private readonly svc: AuditExportService) {}

  @Post("jobs")
  @ResponseSchema(createAuditExportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:export")
  @Idempotent("inventory.audit-export.job.create")
  createJob(
    @Body(new ZodValidationPipe(createAuditExportJobSchema)) body: CreateAuditExportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @ResponseSchema(listAuditExportJobsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:export")
  listJobs(
    @Query(new ZodValidationPipe(listAuditExportJobsQuerySchema)) q: ListAuditExportJobsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, q);
  }

  @Get("jobs/:jobId")
  @ResponseSchema(auditExportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:export")
  findJob(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.findOne(u.orgId, u.userId, jobId);
  }

  @Get("jobs/:jobId/download")
  @ApiOkResponse({
    description: "NDJSON audit export document, streamed",
    content: { "application/x-ndjson": { schema: { type: "string" } } },
  })
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:export")
  download(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    return this.svc.download(u.orgId, u.userId, jobId, res);
  }

  @Get("jobs/:jobId/verify")
  @ResponseSchema(verifyAuditExportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:export")
  verify(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.verify(u.orgId, u.userId, jobId);
  }
}
