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
} from "./dto/kb-space-response.schemas";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const importJobIdParams = z.object({ importJobId: z.coerce.number().int().positive() }).strict();
const jobListQuery = z.object({ cursor: z.string().optional() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbImportExportController {
  constructor(private readonly importExport: KbImportExportService) {}

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
  @RequirePermission("kb:pages:export")
  @Validate({ params: pageIdParams, body: exportPageSchema })
  @ResponseSchema(kbExportResultSchema)
  async exportPage(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: ExportPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.exportPage(u, pageId, body);
  }

  @Get("export-jobs")
  @RequirePermission("kb:pages:export")
  @Validate({ query: jobListQuery })
  @ResponseSchema(kbExportJobListSchema)
  async listExportJobs(
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.listExportJobs(u.orgId, cursor);
  }
}
