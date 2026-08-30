import {
  Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards, Res,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
import { z } from "zod";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/export")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ExportController {
  constructor(private readonly svc: ExportService) {}

  @Post("jobs")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  createJob(
    @Body(new ZodValidationPipe(createExportJobSchema)) body: CreateExportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createExportJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  listJobs(
    @Query(new ZodValidationPipe(listJobsQuerySchema)) q: ListJobsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get("jobs/:jobId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Validate({ params: jobIdParams })
  findJob(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.findOne(u.orgId, id);
  }

  @Get("jobs/:jobId/download")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  @Validate({ params: jobIdParams })
  download(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    return this.svc.download(u.orgId, id, res);
  }
}
