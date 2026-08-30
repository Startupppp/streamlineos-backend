import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { once } from "node:events";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmImportService, type ImportProgress } from "./crm-import.service";
import type { ImportEntity } from "./import-entities";
import { IMPORT_ENTITY_PERMISSIONS } from "./import-permissions";
import { CrmConnectorService } from "./crm-connector.service";
import type { ConnectorProvider, ConnectorStream } from "./connectors/connector-source";
import { streamFor } from "./connectors/connector-catalog";
import { ImportPump } from "./import-pump";
import { CrmExportService, type ExportEntity } from "./crm-export.service";
import {
  connectorSyncSchema,
  exportQuerySchema,
  previewImportSchema,
  type ConnectorSyncInput,
  type ExportQuery,
  type PreviewImportInput,
} from "./dto/crm-import.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const crmImportIdParams = z.object({ crmImportId: z.string().min(1) }).strict();
const crmConnectorSyncIdParams = z.object({ crmConnectorSyncId: z.string().min(1) }).strict();

@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmImportController {
  constructor(
    private readonly imports: CrmImportService,
    private readonly exports: CrmExportService,
    private readonly connectors: CrmConnectorService,
    private readonly pump: ImportPump,
    private readonly access: AccessService,
  ) {}

  /**
   * The caller may import, and may also write the thing this file is.
   *
   * `@RequirePermission("crm:imports:manage")` on the handler answers the first
   * question, and it is static per route — so the second, which depends on the
   * request, is asked here. See `import-permissions.ts` for why it is these keys
   * and why they are not new ones.
   */
  private async assertMayWrite(user: CurrentUserContext, entity: ImportEntity): Promise<void> {
    const key = IMPORT_ENTITY_PERMISSIONS[entity];
    if (await this.access.holds(user, key)) return;

    throw new ForbiddenException(
      `Importing ${entity} records writes them, which needs ${key}.`,
    );
  }

  /** What this file would do. Writes nothing to the CRM. */
  @Post("imports/preview")
  @RequirePermission("crm:imports:manage")
  async preview(
    @Body(new ZodValidationPipe(previewImportSchema)) body: PreviewImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const entity = body.entity as ImportEntity;
    await this.assertMayWrite(u, entity);

    return this.imports.preview({
      organizationId: u.orgId,
      userId: u.userId,
      filename: body.filename,
      entity,
      subjectTypeId: body.subjectTypeId,
      headers: body.headers,
      rows: body.rows,
      overrides: body.overrides,
    });
  }

  @Get("imports/:crmImportId")
  @RequirePermission("crm:imports:manage")
  @Validate({ params: crmImportIdParams })
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
  @Validate({ params: crmImportIdParams })
  async commit(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    await this.assertMayWrite(u, await this.imports.targetEntityOf(u.orgId, crmImportId));

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
  @Validate({ params: crmImportIdParams })
  async revert(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    // An undo writes too: it soft-deletes what the import created and puts back
    // what it overwrote. Same right, same check.
    await this.assertMayWrite(u, await this.imports.targetEntityOf(u.orgId, crmImportId));

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
  @Validate({ params: crmImportIdParams })
  progress(
    @Param("crmImportId") crmImportId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<ImportProgress> {
    return this.imports.progress(u.orgId, crmImportId);
  }

  /**
   * Read a connected CRM forward, and advance it while you are here.
   *
   * The same shape as the commit, and for the same two reasons. `startSync`
   * creates the durable run so the work survives this process, and `advance`
   * executes one attempt because **nothing in this repository schedules
   * `/cron/workflow-tick`** — without the pump a connector would sit at zero
   * while the UI politely polled it.
   *
   * Safe to call repeatedly, and meant to be: each call walks another batch of
   * pages and reports where it got to. A collection larger than one import
   * finishes over several calls, each producing its own reviewable, separately
   * revertable import.
   *
   * Gated on `crm:imports:manage` rather than on an integrations key: what this
   * authorises is writing records into the CRM, and the connection itself was
   * authorised when somebody connected it.
   */
  @Post("connectors/sync")
  @Idempotent("crm.connector.sync")
  @RequirePermission("crm:imports:manage")
  async sync(
    @Body(new ZodValidationPipe(connectorSyncSchema)) body: ConnectorSyncInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertMayWrite(
      u,
      targetOf(body.provider as ConnectorProvider, body.stream as ConnectorStream),
    );

    const { crmConnectorSyncId, workflowRunId } = await this.connectors.startSync({
      organizationId: u.orgId,
      userId: u.userId,
      connectionId: body.connectionId,
      provider: body.provider as ConnectorProvider,
      stream: body.stream as ConnectorStream,
    });

    await this.pump.advance(u.orgId, workflowRunId);
    return this.connectors.progress(u.orgId, crmConnectorSyncId);
  }

  /**
   * Where a connector has got to, without touching it.
   *
   * `resuming` is the one field worth reading twice: true means a walk is
   * part-way through the collection and the next call continues it rather than
   * starting again.
   */
  @Get("connectors/:crmConnectorSyncId")
  @RequirePermission("crm:imports:manage")
  @Validate({ params: crmConnectorSyncIdParams })
  connectorProgress(
    @Param("crmConnectorSyncId") crmConnectorSyncId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.connectors.progress(u.orgId, crmConnectorSyncId);
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

/** What a connected account's records would be landed as. */
function targetOf(provider: ConnectorProvider, stream: ConnectorStream): ImportEntity {
  return streamFor(provider, stream).target;
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
