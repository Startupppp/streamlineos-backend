import {
  Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards, Res,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ExportService } from "./export.service";
import {
  createExportJobSchema,
  listJobsQuerySchema,
  type CreateExportJobInput,
  type ListJobsQueryInput,
} from "./dto/import-export.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  createExportJobResponseSchema,
  listExportJobsResponseSchema,
} from "./dto/import-export-response.schemas";
import { z } from "zod";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/export")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ExportController {
  constructor(private readonly svc: ExportService) {}

  @Post("jobs")
  @ResponseSchema(createExportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Idempotent("inventory.export.job.create")
  @Validate({ body: createExportJobSchema })
  createJob(
    @Body() body: CreateExportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createExportJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @ResponseSchema(listExportJobsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Validate({ query: listJobsQuerySchema })
  listJobs(
    @Query() q: ListJobsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get("jobs/:jobId")
  @ResponseSchema(createExportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Validate({ params: jobIdParams })
  findJob(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.findOne(u.orgId, id);
  }

  @Get("jobs/:jobId/download")
  @ApiOkResponse({ description: "CSV file download of export job data", content: { "text/csv": { schema: { type: "string" } } } })
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Validate({ params: jobIdParams })
  download(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    return this.svc.download(u.orgId, id, res);
  }
}
