import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbImportExportService } from "./kb-import-export.service";
import {
  exportPageSchema,
  importPagesSchema,
  type ExportPageInput,
  type ImportPagesInput,
} from "./dto/kb-import-export.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbImportExportController {
  constructor(private readonly importExport: KbImportExportService) {}

  @Post("pages/import")
  @RequirePermission("kb:pages:import")
  async importPages(
    @Body(new ZodValidationPipe(importPagesSchema)) body: ImportPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.importPages(u, body);
  }

  @Get("import-jobs")
  @RequirePermission("kb:pages:import")
  async listImportJobs(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.importExport.listImportJobs(u.orgId);
  }

  @Post("pages/:pageId/export")
  @RequirePermission("kb:pages:export")
  async exportPage(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(exportPageSchema)) body: ExportPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.importExport.exportPage(u, pageId, body);
  }

  @Get("export-jobs")
  @RequirePermission("kb:pages:export")
  async listExportJobs(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.importExport.listExportJobs(u.orgId);
  }
}
