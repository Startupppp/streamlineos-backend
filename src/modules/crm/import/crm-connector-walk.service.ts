import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmConnectorRecords, crmConnectorSyncs } from "../../../db/schema";
import { ComposioGateway } from "../../integrations/core/composio.gateway";
import { CrmImportService } from "./crm-import.service";
import { MAX_ROWS } from "./crm-import-preview.service";
import { streamFor } from "./connectors/connector-catalog";
import { watermarkAfterWalk } from "./connectors/connector-watermark";
import {
  newestModifiedAt,
  toIntermediate,
  type ConnectorProvider,
  type ConnectorRequest,
  type ConnectorStream,
  type SourceRecord,
} from "./connectors/connector-source";
import {
  settled,
  getSync,
  getConnection,
  FAILURE_LIMIT,
  type WalkExtent,
  type PageOutcome,
  type WalkResult,
} from "./crm-connector-internals";

@Injectable()
export class CrmConnectorWalkService {
  private readonly logger = new Logger("CrmConnector");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly composio: ComposioGateway,
    private readonly imports: CrmImportService,
  ) {}

  async beginWalk(organizationId: string, crmConnectorSyncId: string): Promise<WalkExtent> {
    const sync = await getSync(this.db, organizationId, crmConnectorSyncId);
    if (!sync) return settled("That connector sync no longer exists.");
    if (!sync.enabled) return settled("This connector is switched off.");
    if (sync.consecutiveFailures >= FAILURE_LIMIT)
      return settled(
        `This connector has failed ${String(FAILURE_LIMIT)} times in a row and has stopped trying.`,
      );

    const connection = await getConnection(this.db, organizationId, sync.connectionId);
    if (!connection) return settled("The account was disconnected.");
    if (connection.status !== "active")
      return settled("That account needs to be reconnected before it can be read.");

    const descriptor = streamFor(
      sync.provider as ConnectorProvider,
      sync.stream as ConnectorStream,
    );

    return {
      settled: false,
      reason: null,
      startAt: sync.cursor ?? descriptor.firstRequest(sync.syncedThrough),
      since: sync.syncedThrough ? sync.syncedThrough.toISOString() : null,
    };
  }

  async fetchPage(
    organizationId: string,
    crmConnectorSyncId: string,
    request: ConnectorRequest,
  ): Promise<PageOutcome> {
    const sync = await getSync(this.db, organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    const connection = await getConnection(this.db, organizationId, sync.connectionId);
    if (!connection) throw new ConflictException("The account was disconnected mid-read.");

    const descriptor = streamFor(
      sync.provider as ConnectorProvider,
      sync.stream as ConnectorStream,
    );

    const raw: unknown = await this.composio.executeProxy(
      connection.composioAccountId,
      request.method,
      request.path,
    );

    const page = descriptor.parsePage(raw);

    const staged = await this.stage(organizationId, crmConnectorSyncId, page.records);
    const total = await this.stagedCount(organizationId, crmConnectorSyncId);

    await this.db
      .update(crmConnectorSyncs)
      .set({ cursor: page.next, lastRunAt: new Date(), lastError: null, consecutiveFailures: 0 })
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    return { staged, total, next: page.next };
  }

  isFull(total: number): boolean {
    return total >= MAX_ROWS;
  }

  async finishWalk(
    organizationId: string,
    crmConnectorSyncId: string,
    drained: boolean,
  ): Promise<WalkResult> {
    const sync = await getSync(this.db, organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    const connection = await getConnection(this.db, organizationId, sync.connectionId);
    const staged = await this.stagedRecords(organizationId, crmConnectorSyncId);

    if (staged.length === 0) {
      if (drained) await this.advance(organizationId, crmConnectorSyncId, null, true);
      return { crmImportId: null, records: 0, drained, watermarkAdvanced: false };
    }

    const descriptor = streamFor(
      sync.provider as ConnectorProvider,
      sync.stream as ConnectorStream,
    );

    const { headers, rows } = toIntermediate(descriptor.fields, staged);

    const preview = await this.imports.preview({
      organizationId,
      userId: connection?.userId ?? sync.connectionId.toString(),
      filename: `${sync.provider} ${sync.stream} (connected account)`,
      entity: descriptor.target,
      headers,
      rows,
    });

    const newest = newestModifiedAt(staged);
    const advanced = await this.advance(organizationId, crmConnectorSyncId, newest, drained);

    await this.clearStaged(organizationId, crmConnectorSyncId);

    await this.db
      .update(crmConnectorSyncs)
      .set({ crmImportId: preview.crmImportId })
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    this.logger.log(
      `${sync.provider}/${sync.stream}: ${String(staged.length)} records into import ` +
        `${preview.crmImportId}${drained ? ", collection drained" : ", more to come"}`,
    );

    return {
      crmImportId: preview.crmImportId,
      records: staged.length,
      drained,
      watermarkAdvanced: advanced,
    };
  }

  private async advance(
    organizationId: string,
    crmConnectorSyncId: string,
    newest: Date | null,
    drained: boolean,
  ): Promise<boolean> {
    const sync = await getSync(this.db, organizationId, crmConnectorSyncId);
    const current = sync?.syncedThrough ?? null;
    const next = watermarkAfterWalk(current, newest, drained);

    await this.db
      .update(crmConnectorSyncs)
      .set({
        ...(drained ? { cursor: null } : {}),
        ...(next ? { syncedThrough: next } : {}),
        lastRunAt: new Date(),
      })
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    return next !== null && next.getTime() !== (current?.getTime() ?? -1);
  }

  private async stage(
    organizationId: string,
    crmConnectorSyncId: string,
    records: readonly SourceRecord[],
  ): Promise<number> {
    const identified = records.filter((record) => record.sourceId.trim().length > 0);
    if (identified.length === 0) return 0;

    const inserted = await this.db
      .insert(crmConnectorRecords)
      .values(
        identified.map((record) => ({
          organizationId,
          crmConnectorSyncId,
          sourceId: record.sourceId,
          sourceModifiedAt: record.modifiedAt,
          values: { ...record.values },
        })),
      )
      .onConflictDoNothing()
      .returning({ id: crmConnectorRecords.crmConnectorRecordId });

    return inserted.length;
  }

  private async stagedCount(
    organizationId: string,
    crmConnectorSyncId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(crmConnectorRecords)
      .where(
        and(
          eq(crmConnectorRecords.organizationId, organizationId),
          eq(crmConnectorRecords.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    return row?.count ?? 0;
  }

  private async stagedRecords(
    organizationId: string,
    crmConnectorSyncId: string,
  ): Promise<SourceRecord[]> {
    const rows = await this.db
      .select({
        sourceId: crmConnectorRecords.sourceId,
        modifiedAt: crmConnectorRecords.sourceModifiedAt,
        values: crmConnectorRecords.values,
      })
      .from(crmConnectorRecords)
      .where(
        and(
          eq(crmConnectorRecords.organizationId, organizationId),
          eq(crmConnectorRecords.crmConnectorSyncId, crmConnectorSyncId),
        ),
      )
      .orderBy(asc(crmConnectorRecords.stagedAt), asc(crmConnectorRecords.sourceId))
      .limit(MAX_ROWS);

    return rows.map((row) => ({
      sourceId: row.sourceId,
      modifiedAt: row.modifiedAt,
      values: row.values,
    }));
  }

  private async clearStaged(
    organizationId: string,
    crmConnectorSyncId: string,
  ): Promise<void> {
    await this.db
      .delete(crmConnectorRecords)
      .where(
        and(
          eq(crmConnectorRecords.organizationId, organizationId),
          eq(crmConnectorRecords.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );
  }
}
