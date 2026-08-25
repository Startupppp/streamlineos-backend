import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { once } from "node:events";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { CrmImportService } from "./crm-import.service";
import { CrmExportService, type ExportEntity } from "./crm-export.service";
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
   *
   * Written to the socket as it is read rather than assembled first, so the
   * answer is bounded by what the tenant has rather than by what fits in
   * memory. That is also why these handlers take the response itself: a
   * streamed body never reaches the global response interceptor.
   */
  @Get("export")
  @RequirePermission("party:parties:view")
  async exportEntity(
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const entity = query.entity as ExportEntity;
    const stamp = new Date().toISOString().slice(0, 10);
    const json = query.format === "json";

    res.setHeader(
      "Content-Type",
      json ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${entity}-${stamp}.${json ? "json" : "csv"}"`,
    );

    await writeAll(
      res,
      json ? envelope(this.exports.jsonChunks(u.orgId, entity)) : this.exports.csvChunks(u.orgId, entity),
    );
  }

  /** Every entity at once, as one document. */
  @Get("export/archive")
  @RequirePermission("party:parties:view")
  async archive(@CurrentUser() u: CurrentUserContext, @Res() res: Response): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="crm-archive-${stamp}.json"`);

    await writeAll(res, envelope(this.exports.archiveChunks(u.orgId)));
  }
}

/**
 * The `{ success, data }` shape every other response carries.
 *
 * `ResponseTransformInterceptor` adds it to whatever a handler returns, and a
 * streamed body is written past it. Written here so a caller does not have to
 * parse this one endpoint differently from the rest of the API.
 */
async function* envelope(body: AsyncGenerator<string>): AsyncGenerator<string> {
  yield '{"success":true,"data":';
  yield* body;
  yield "}";
}

/**
 * Writes a stream to the response, waiting when the socket is full.
 *
 * Without the drain, a fast query and a slow connection queue the whole export
 * in Node's memory — which is the problem streaming was for.
 */
async function writeAll(res: Response, chunks: AsyncGenerator<string>): Promise<void> {
  for await (const chunk of chunks) {
    if (res.destroyed) return;
    if (!res.write(chunk)) await once(res, "drain");
  }
  res.end();
}
