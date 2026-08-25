import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { CrmImportService } from "./crm-import.service";
import { CrmExportService, toCsv, type ExportEntity } from "./crm-export.service";
import {
  exportQuerySchema,
  previewImportSchema,
  type ExportQuery,
  type PreviewImportInput,
} from "./dto/crm-import.schemas";

@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmImportController {
  constructor(
    private readonly imports: CrmImportService,
    private readonly exports: CrmExportService,
  ) {}

  /** What this file would do. Writes nothing to the CRM. */
  @Post("imports/preview")
  @RequirePermission("crm:imports:manage")
  preview(
    @Body(new ZodValidationPipe(previewImportSchema)) body: PreviewImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.preview({
      organizationId: u.orgId,
      userId: u.userId,
      filename: body.filename,
      headers: body.headers,
      rows: body.rows,
      overrides: body.overrides,
    });
  }

  @Get("imports/:crmImportId")
  @RequirePermission("crm:imports:manage")
  getImport(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.getImport(u.orgId, crmImportId);
  }

  @Post("imports/:crmImportId/commit")
  @Idempotent("crm.import.commit")
  @RequirePermission("crm:imports:manage")
  commit(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.commit(u.orgId, crmImportId);
  }

  /** Take the whole thing back, in one action. */
  @Post("imports/:crmImportId/revert")
  @Idempotent("crm.import.revert")
  @RequirePermission("crm:imports:manage")
  revert(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.revert(u.orgId, u.userId, crmImportId);
  }

  /**
   * Everything back out, in an open format.
   *
   * Gated on reading the data, not on a plan or an export-specific right.
   * Making departure easy is the argument against incumbents who make it hard,
   * and anybody who may read these records may take them with them.
   */
  @Get("export")
  @RequirePermission("party:parties:view")
  async exportEntity(
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.exports.rowsFor(u.orgId, query.entity as ExportEntity);
    const stamp = new Date().toISOString().slice(0, 10);

    if (query.format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${query.entity}-${stamp}.json"`);
      return rows;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${query.entity}-${stamp}.csv"`);
    res.send(toCsv(rows));
    return undefined;
  }

  /** Every entity at once, as one document. */
  @Get("export/archive")
  @RequirePermission("party:parties:view")
  @Header("Content-Type", "application/json; charset=utf-8")
  async archive(@CurrentUser() u: CurrentUserContext, @Res({ passthrough: true }) res: Response) {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="crm-archive-${stamp}.json"`);
    return this.exports.archive(u.orgId);
  }
}
