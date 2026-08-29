import { Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards, BadRequestException, UseInterceptors, UploadedFile } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ImportService } from "./import.service";
import { StagedImportService } from "./staged-import.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  previewImportSchema,
  createImportJobSchema,
  listJobsQuerySchema,
  type PreviewImportInput,
  type CreateImportJobInput,
  type ListJobsQueryInput,
  openImportJobSchema,
  stageImportRowsSchema,
  importErrorsQuerySchema,
  type OpenImportJobInput,
  type StageImportRowsInput,
  type ImportErrorsQueryInput,
} from "./dto/import-export.schemas";

@RequireModule("inventory")
@Controller("inventory/import")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ImportController {
  constructor(
    private readonly svc: ImportService,
    private readonly staged: StagedImportService,
  ) {}

  /**
   * INV-108. A hundred thousand rows do not fit in a request body, so the file
   * is uploaded as a job, staged in chunks, then processed against a cursor.
   * Each call is small enough to retry and the job survives every one of them.
   */
  @Post("staged")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  @Idempotent("inventory.import.open")
  openStaged(
    @Body(new ZodValidationPipe(openImportJobSchema)) body: OpenImportJobInput,
    @CurrentUser() u: CurrentUserContext,
    @IdempotencyKey() idempotencyKey: string,
  ) {
    return this.staged.createJob(u.orgId, u.userId, { ...body, idempotencyKey });
  }

  @Post("staged/:jobId/rows")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  stageRows(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(stageImportRowsSchema)) body: StageImportRowsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.staged.stageRows(u.orgId, jobId, body.rows);
  }

  /** Applies the next chunk. Call until `finished` — that is the resume loop. */
  @Post("staged/:jobId/process")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  processChunk(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.processStagedChunk(u.orgId, u.userId, jobId);
  }

  @Post("staged/:jobId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  cancelStaged(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.staged.cancel(u.orgId, u.userId, jobId);
  }

  @Get("staged/:jobId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  stagedProgress(
    @Param("jobId", ParseIntPipe) jobId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.staged.progress(u.orgId, jobId);
  }

  @Get("staged/:jobId/errors")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:import")
  stagedErrors(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Query(new ZodValidationPipe(importErrorsQuerySchema)) query: ImportErrorsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.staged.errors(u.orgId, jobId, query.page, query.limit);
  }

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
    return this.svc.previewImport(u.orgId, file, body.importType);
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
