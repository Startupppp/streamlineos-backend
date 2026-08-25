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
import { CrmImportService, type ImportProgress } from "./crm-import.service";
import { ImportPump } from "./import-pump";
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
    private readonly pump: ImportPump,
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

  /**
   * Hand the file to the durable runtime, and advance it while you are here.
   *
   * Two things happen and both are necessary. `startCommit` creates the run —
   * once, re-using a live one — so the work survives this process. `advance`
   * then executes one attempt of it, because **nothing in this repository
   * schedules `/cron/workflow-tick`**: without the pump a durable import in a
   * deployment with no external ticker would sit at zero forever while the UI
   * politely polled it. See `import-pump.ts`.
   *
   * Safe to call repeatedly, and meant to be: each call advances the import by
   * one attempt and reports where it has got to, so a caller finishes a large
   * file by calling again rather than by holding a request open. `complete` is
   * the only terminating condition — a call that reports no progress means the
   * run is between attempts, not that anything is wrong.
   */
  @Post("imports/:crmImportId/commit")
  @Idempotent("crm.import.commit")
  @RequirePermission("crm:imports:manage")
  async commit(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    const runId = await this.imports.startCommit(u.orgId, crmImportId);
    await this.pump.advance(u.orgId, runId);
    return this.imports.progress(u.orgId, crmImportId);
  }

  /**
   * Take the whole thing back, inside the window it promised.
   *
   * The same shape as the commit, for the same reason: five thousand rows are
   * five thousand rows to put back, and an undo that dies halfway through a
   * request is worse than the import it was undoing.
   */
  @Post("imports/:crmImportId/revert")
  @Idempotent("crm.import.revert")
  @RequirePermission("crm:imports:manage")
  async revert(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    const runId = await this.imports.startRevert(u.orgId, u.userId, crmImportId);
    await this.pump.advance(u.orgId, runId);
    return this.imports.progress(u.orgId, crmImportId);
  }

  /**
   * Where it has got to, without touching it.
   *
   * A pure read, so a screen can watch an import that a cron tick is advancing
   * without every observer starting an attempt of its own.
   */
  @Get("imports/:crmImportId/progress")
  @RequirePermission("crm:imports:manage")
  progress(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    return this.imports.progress(u.orgId, crmImportId);
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
