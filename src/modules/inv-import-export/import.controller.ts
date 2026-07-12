import {
  Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards,
  BadRequestException, UseInterceptors, UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { ImportService } from "./import.service";
import {
  previewImportSchema,
  createImportJobSchema,
  listJobsQuerySchema,
  type PreviewImportInput,
  type CreateImportJobInput,
  type ListJobsQueryInput,
} from "./dto/import-export.schemas";

@RequireModule("inventory")
@Controller("inventory/import")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  @Post("preview")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(previewImportSchema)) body: PreviewImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    return this.svc.previewImport(u.orgId, u.userId, file, body.importType);
  }

  @Post("jobs")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  createJob(
    @Body(new ZodValidationPipe(createImportJobSchema)) body: CreateImportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createImportJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  listJobs(
    @Query(new ZodValidationPipe(listJobsQuerySchema)) q: ListJobsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get("jobs/:jobId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  findJob(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.findOne(u.orgId, id);
  }
}
