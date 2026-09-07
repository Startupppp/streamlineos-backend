import {
  Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards,
  BadRequestException, UseInterceptors, UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ImportService } from "./import.service";
import {
  previewImportSchema,
  createImportJobSchema,
  listJobsQuerySchema,
  type PreviewImportInput,
  type CreateImportJobInput,
  type ListJobsQueryInput,
} from "./dto/import-export.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { MultipartAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  importPreviewResponseSchema,
  createImportJobResponseSchema,
  listImportJobsResponseSchema,
} from "./dto/import-export-response.schemas";
import { z } from "zod";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/import")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  @Post("preview")
  @ResponseSchema(importPreviewResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @MultipartAction({ file: "file", fields: { importType: "string" }, requiredFields: ["importType"] })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Validate({ body: previewImportSchema })
  preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: PreviewImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    return this.svc.previewImport(u.orgId, file, body.importType);
  }

  @Post("jobs")
  @ResponseSchema(createImportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @Validate({ body: createImportJobSchema })
  createJob(
    @Body() body: CreateImportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createImportJob(u.orgId, u.userId, body);
  }

  @Get("jobs")
  @ResponseSchema(listImportJobsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @Validate({ query: listJobsQuerySchema })
  listJobs(
    @Query() q: ListJobsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get("jobs/:jobId")
  @ResponseSchema(createImportJobResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @Validate({ params: jobIdParams })
  findJob(@Param("jobId", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.findOne(u.orgId, id);
  }
}
