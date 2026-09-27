import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { KbImportExportService } from "./kb-import-export.service";
import { KbExportService } from "./kb-export.service";
import {
  exportPageSchema,
  importPagesSchema,
  type ExportPageInput,
  type ImportPagesInput,
} from "./dto/kb-import-export.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import {
  BodylessAction,
  ResponseSchema,
} from "../../../common/openapi/zod-operation-contracts";
import {
  kbImportAcceptedSchema,
  kbImportDryRunSchema,
  kbImportJobCancelSchema,
  kbImportJobListSchema,
  kbImportJobSchema,
  kbExportResultSchema,
  kbExportJobListSchema,
  kbExportDownloadSchema,
} from "./dto/kb-space-response.schemas";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const importJobIdParams = z.object({ importJobId: z.coerce.number().int().positive() }).strict();
const exportJobIdParams = z.object({ exportJobId: z.coerce.number().int().positive() }).strict();
const jobListQuery = z.object({ cursor: z.string().optional() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbImportExportController {
  constructor(
    private readonly importExport: KbImportExportService,
    private readonly exportSvc: KbExportService,
  ) {}

  @Post("pages/import")
  @Idempotent("kb:pages.import")
  @RequirePermission("kb:pages:import")
  @Validate({ body: importPagesSchema })
  @ResponseSchema(kbImportAcceptedSchema)
  async importPages(
    @Body() body: ImportPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.importPages(u, body);
  }

  @Post("pages/import/dry-run")
  @RequirePermission("kb:pages:import")
  @Validate({ body: importPagesSchema })
  @ResponseSchema(kbImportDryRunSchema)
  async dryRunImport(
    @Body() body: ImportPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.dryRunImport(u, body);
  }

  @Get("import-jobs")
  @RequirePermission("kb:pages:import")
  @Validate({ query: jobListQuery })
  @ResponseSchema(kbImportJobListSchema)
  async listImportJobs(
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.listImportJobs(u.orgId, cursor);
  }

  @Get("import-jobs/:importJobId")
  @RequirePermission("kb:pages:import")
  @Validate({ params: importJobIdParams })
  @ResponseSchema(kbImportJobSchema)
  async getImportJob(
    @Param("importJobId", ParseIntPipe) importJobId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.getImportJob(u.orgId, importJobId);
  }

  @Post("import-jobs/:importJobId/retry")
  @RequirePermission("kb:pages:import")
  @Validate({ params: importJobIdParams })
  @ResponseSchema(kbImportAcceptedSchema)
  async retryImportJob(
    @Param("importJobId", ParseIntPipe) importJobId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.retryImportJob(u, importJobId);
  }

  @Post("import-jobs/:importJobId/cancel")
  @RequirePermission("kb:pages:import")
  @Validate({ params: importJobIdParams })
  @BodylessAction()
  @ResponseSchema(kbImportJobCancelSchema)
  async cancelImportJob(
    @Param("importJobId", ParseIntPipe) importJobId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.cancelImportJob(u.orgId, importJobId);
  }

  @Post("pages/:pageId/export")
  @NoTenantTransaction()
  @RequirePermission("kb:pages:export")
  @Validate({ params: pageIdParams, body: exportPageSchema })
  @ResponseSchema(kbExportResultSchema)
  async exportPage(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: ExportPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.exportSvc.exportPage(u, pageId, body);
  }

  @Get("export-jobs")
  @RequirePermission("kb:pages:export")
  @Validate({ query: jobListQuery })
  @ResponseSchema(kbExportJobListSchema)
  async listExportJobs(
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.exportSvc.listExportJobs(u.orgId, cursor);
  }

  @Get("export-jobs/:exportJobId/download")
  @RequirePermission("kb:pages:export")
  @Validate({ params: exportJobIdParams })
  @ResponseSchema(kbExportDownloadSchema)
  async downloadExportJob(
    @Param("exportJobId", ParseIntPipe) exportJobId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.exportSvc.getExportJobDownload(u.orgId, exportJobId);
  }
}
