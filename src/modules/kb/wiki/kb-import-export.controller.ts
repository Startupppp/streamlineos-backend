import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbImportResultSchema,
  kbImportJobListSchema,
  kbExportResultSchema,
  kbExportJobListSchema,
} from "./dto/kb-space-response.schemas";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbImportExportController {
  constructor(private readonly importExport: KbImportExportService) {}

  @Post("pages/import")
  @Idempotent("kb:pages.import")
  @RequirePermission("kb:pages:import")
  @Validate({ body: importPagesSchema })
  @ResponseSchema(kbImportResultSchema)
  async importPages(
    @Body() body: ImportPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.importPages(u, body);
  }

  @Get("import-jobs")
  @RequirePermission("kb:pages:import")
  @ResponseSchema(kbImportJobListSchema)
  async listImportJobs(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.importExport.listImportJobs(u.orgId);
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
  @ResponseSchema(kbExportJobListSchema)
  async listExportJobs(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.importExport.listExportJobs(u.orgId);
  }
}
