import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  crmConnectorRecords,
  crmConnectorSyncs,
  userIntegrationConnections,
  workflowRuns,
} from "../../db/schema";
import { WorkflowRunnerService } from "../../common/workflow";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { ComposioGateway } from "../integrations/core/composio.gateway";
import { CrmImportService, MAX_ROWS } from "./crm-import.service";
import { connectorFor, streamFor } from "./connectors/connector-catalog";
import { watermarkAfterWalk } from "./connectors/connector-watermark";
import {
  newestModifiedAt,
  toIntermediate,
  type ConnectorProvider,
  type ConnectorRequest,
  type ConnectorStream,
  type SourceRecord,
} from "./connectors/connector-source";
import { CONNECTOR_SYNC_WORKFLOW } from "./import-workflow-names";

/**
 * Reading a competitor's CRM, and handing what it read to the importer.
 *
 * Connectivity is Composio's and the `integrations` module's, exactly as the
 * platform rule requires: this reads `user_integration_connections` for a
 * connected account id and goes out through `ComposioGateway.executeProxy`. No
 * provider OAuth runs here, no token is read, no token is stored, and nothing is
 * written to that table — it is mirrored, not owned. The only credential in play
 * is Composio's own API key, which lives in the environment and never in a row.
 *
 * ── One destination ────────────────────────────────────────────────────────
 *
 * This service cannot write a party. It stages what it read, turns the staged
 * records into a header row and cell rows, and calls `CrmImportService.preview`
 * — the same method the paste path calls with the same arguments. Everything
 * after that is the importer: the same mapping, the same duplicate scoring, the
 * same held-for-review band, the same durable commit, the same thirty-day undo.
 * A connector cannot acquire its own write path because there is no second write
 * path for it to acquire, and that is a property of this file's shape rather
 * than a rule somebody has to remember.
 *
 * ── Resuming, never restarting ─────────────────────────────────────────────
 *
 * Three separate mechanisms, because there are three different ways a walk stops.
 *
 * **A page fails.** The step that fetched it rolls back, so nothing was staged
 * and the cursor did not move. The durable runtime re-runs that step; the pages
 * before it are memoised and are not re-fetched. A rate limit is this case:
 * `executeProxy` throws on 429 like any other status at or above 400, the
 * attempt fails, and the runtime's backoff decides when to come back.
 *
 * **The attempt runs out of time.** The run suspends between pages and is
 * re-claimed later, carrying the same memoised frontier.
 *
 * **The run dies entirely, or the collection is larger than one import.** The
 * cursor persisted after the last successful page is where the next walk starts.
 * That is the piece the mailbox sweep considered and left out — its comment says
 * a persisted cursor "would drain a backlog of any size, but it needs two
 * columns and a migration" — and it is why a connector can migrate an account
 * that does not fit in one file.
 *
 * ── The watermark ──────────────────────────────────────────────────────────
 *
 * `syncedThrough` moves only when a walk reaches the end of the collection, and
 * only to the newest modification time among records that were actually staged.
 * Never to "now", never to the newest record of a partial page, and never at all
 * on a failure. The reasoning is in the schema file and it is stricter than the
 * mailbox rule for a reason the schema file gives: a CRM list has no order this
 * repository can rely on, so a half-finished walk supports no claim about a time
 * range whatsoever.
 */

/**
 * Pages per attempt, matching the mailbox sweep's budget for the same reason:
 * an attempt has to end somewhere, and the cursor means ending early costs a
 * continuation rather than a gap.
 */
export const MAX_PAGES_PER_WALK = 25;

/**
 * After this many consecutive failures a connector stops trying.
 *
 * The same number as `mailbox-sync`'s `FAILURE_LIMIT`, and the same argument: a
 * connector that has failed ten times in a row is not going to succeed on the
 * eleventh, and a revoked account should stop costing requests.
 */
export const FAILURE_LIMIT = 10;

/** What `sync-begin` freezes for the life of a run. A type alias, so it is `JsonValue`. */
export type WalkExtent = {
  /** Nothing for this run to do — disabled, too many failures, or gone. */
  readonly settled: boolean;
  readonly reason: string | null;
  /**
   * Where this walk starts: the persisted cursor if a previous run stopped
   * part-way, and the stream's own first request otherwise.
   *
   * Resolved here rather than in the workflow so the choice is inside
   * `sync-begin`'s memo. A handler that decided it in the loop would decide it
   * afresh on every attempt, and an attempt that ran after a cursor was written
   * would start somewhere the earlier attempts did not.
   */
  readonly startAt: ConnectorRequest | null;
  /** The watermark, as an ISO string, or null on a first walk. */
  readonly since: string | null;
};

export type PageOutcome = {
  readonly staged: number;
  /** Everything staged for this walk so far, so the loop knows when it is full. */
  readonly total: number;
  readonly next: ConnectorRequest | null;
};

export type WalkResult = {
  readonly crmImportId: string | null;
  readonly records: number;
  readonly drained: boolean;
  readonly watermarkAdvanced: boolean;
};

@Injectable()
export class CrmConnectorService {
  private readonly logger = new Logger("CrmConnector");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly composio: ComposioGateway,
    private readonly imports: CrmImportService,
    private readonly workflows: WorkflowRunnerService,
  ) {}

  // ── Starting a sync ───────────────────────────────────────────────────────

  /**
   * Make sure this connection has a watermark for this stream, and hand back a
   * run that will advance it.
   *
   * The stream is refused here — before the row exists and long before any
   * request is made — when its target has no importer. A connector that read a
   * competitor's activities and dropped them would be indistinguishable from one
   * that worked, right up until somebody looked for the activities.
   */
  async startSync(input: {
    organizationId: string;
    userId: string;
    connectionId: number;
    provider: ConnectorProvider;
    stream: ConnectorStream;
  }): Promise<{ crmConnectorSyncId: string; workflowRunId: string }> {
    const descriptor = streamFor(input.provider, input.stream);

    if (!descriptor.writable)
      throw new BadRequestException(
        `${input.provider} ${input.stream} records map onto ${descriptor.target}, which has no importer yet. ` +
          "Only records that land as parties can be brought in, so this would read them and write nothing.",
      );

    return this.inOwnTransaction(input.organizationId, async () => {
      const connection = await this.connection(input.organizationId, input.connectionId);

      // Another organisation's connection is indistinguishable from one that is
      // not there, and a disconnect deletes the row outright.
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.userId !== input.userId)
        throw new NotFoundException("Connection not found");

      /**
       * Widened to `string` on the way out of the row, not cast into one.
       *
       * `toolkit` is a plain `text` column wearing a three-member TypeScript
       * union, and none of these four providers is in it. What the compiler
       * thinks is in the column is one question; what is in it at runtime is
       * this service's, and it has to be checked — a Gmail connection id handed
       * to this method must not become a request for somebody's mail.
       */
      const toolkit: string = connection.toolkit;
      if (toolkit !== connectorFor(input.provider).toolkit)
        throw new BadRequestException(
          `That connection is a ${toolkit} account, not ${input.provider}.`,
        );

      const syncId = await this.ensureSync(input);
      const runId = await this.claimRun(input.organizationId, syncId);

      return { crmConnectorSyncId: syncId, workflowRunId: runId };
    });
  }

  private async ensureSync(input: {
    organizationId: string;
    connectionId: number;
    provider: ConnectorProvider;
    stream: ConnectorStream;
  }): Promise<string> {
    const [existing] = await this.db
      .select({ id: crmConnectorSyncs.crmConnectorSyncId })
      .from(crmConnectorSyncs)
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, input.organizationId),
          eq(crmConnectorSyncs.connectionId, input.connectionId),
          eq(crmConnectorSyncs.stream, input.stream),
        ),
      )
      .limit(1);

    if (existing) return existing.id;

    const [created] = await this.db
      .insert(crmConnectorSyncs)
      .values({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        provider: input.provider,
        stream: input.stream,
      })
      /**
       * Two requests arriving together would both find nothing above and both
       * insert. The unique index makes the second a no-op rather than a 23505
       * the caller has to interpret, and the re-read below finds whichever won.
       */
      .onConflictDoNothing()
      .returning({ id: crmConnectorSyncs.crmConnectorSyncId });

    if (created) return created.id;

    const [raced] = await this.db
      .select({ id: crmConnectorSyncs.crmConnectorSyncId })
      .from(crmConnectorSyncs)
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, input.organizationId),
          eq(crmConnectorSyncs.connectionId, input.connectionId),
          eq(crmConnectorSyncs.stream, input.stream),
        ),
      )
      .limit(1);

    if (!raced) throw new ConflictException("Could not start the connector sync.");
    return raced.id;
  }

  /**
   * Re-uses the live run rather than starting a second.
   *
   * A caller polling by re-POSTing must not spawn a run per poll, and two runs
   * walking one cursor would each read the other's progress as their own — the
   * race the unique index on the sync exists to prevent, arriving through a
   * different door.
   */
  private async claimRun(organizationId: string, crmConnectorSyncId: string): Promise<string> {
    const [sync] = await this.db
      .select({ workflowRunId: crmConnectorSyncs.workflowRunId })
      .from(crmConnectorSyncs)
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      )
      .limit(1);

    if (sync?.workflowRunId) {
      const [run] = await this.db
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(
          and(
            // `workflow_runs` is deliberately outside row-level security, so the
            // organisation is a predicate here rather than something the
            // database is asserting for us.
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowRunId, sync.workflowRunId),
          ),
        )
        .limit(1);

      if (run && ["PENDING", "RUNNING", "SLEEPING"].includes(run.status))
        return sync.workflowRunId;
    }

    const runId = await this.workflows.start({
      organizationId,
      workflowName: CONNECTOR_SYNC_WORKFLOW,
      input: { crmConnectorSyncId },
      maxAttempts: 5,
    });

    if (!runId) throw new ConflictException("Could not start the connector sync run.");

    await this.db
      .update(crmConnectorSyncs)
      .set({ workflowRunId: runId })
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    return runId;
  }

  // ── The walk ──────────────────────────────────────────────────────────────

  /**
   * What this run is going to do, frozen once.
   *
   * Read from the row rather than passed in, because a run is re-executed from
   * the top on every attempt and re-claimed after every suspension: anything the
   * handler carried across one of those would be a value from a previous
   * lifetime. `settled` covers every reason not to proceed, as a value rather
   * than a throw, because "this connector is switched off" is an answer and a
   * dead-lettered workflow is not.
   */
  async beginWalk(organizationId: string, crmConnectorSyncId: string): Promise<WalkExtent> {
    const sync = await this.sync(organizationId, crmConnectorSyncId);
    if (!sync) return settled("That connector sync no longer exists.");
    if (!sync.enabled) return settled("This connector is switched off.");
    if (sync.consecutiveFailures >= FAILURE_LIMIT)
      return settled(
        `This connector has failed ${String(FAILURE_LIMIT)} times in a row and has stopped trying.`,
      );

    const connection = await this.connection(organizationId, sync.connectionId);
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

  /**
   * Read one page, stage what it holds, and record where the next one is.
   *
   * One transaction, because the two writes are one fact: these records were
   * read AND the cursor now points past them. Split, a crash between them either
   * loses a page or skips one. Together, a failure rolls back both and the page
   * is simply read again — which the unique index on `source_id` makes free.
   */
  async fetchPage(
    organizationId: string,
    crmConnectorSyncId: string,
    request: ConnectorRequest,
  ): Promise<PageOutcome> {
    const sync = await this.sync(organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    const connection = await this.connection(organizationId, sync.connectionId);
    if (!connection) throw new ConflictException("The account was disconnected mid-read.");

    const descriptor = streamFor(
      sync.provider as ConnectorProvider,
      sync.stream as ConnectorStream,
    );

    /**
     * Verified against `telephony-call-log.service.ts:286` and the four Outlook
     * call sites, which are the only production callers of this method: it is
     * positional — `(connectedAccountId, method, endpoint, body?)` — the third
     * argument is a PATH that Composio resolves a base for, and there is no way
     * to pass query parameters or headers separately. Every connector therefore
     * builds its query into the path, which is what those call sites do too.
     */
    const raw: unknown = await this.composio.executeProxy(
      connection.composioAccountId,
      request.method,
      request.path,
    );

    // Throws on an unrecognised payload. Nothing below runs, so nothing moves.
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

  /**
   * Records that were not already staged, inserted.
   *
   * `ON CONFLICT DO NOTHING` on `(organization_id, sync, source_id)`, so a page
   * re-read after a failure — or a record the provider returned twice across a
   * page boundary, which offset paging does whenever the collection changes
   * underneath it — stages once.
   *
   * A record the provider gave no identifier for is dropped rather than given
   * one: without an id there is no claim, so it would be re-staged on every
   * re-read and the import would carry a copy per attempt.
   */
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

  /** The importer's own ceiling, so a walk stops where a preview would refuse. */
  isFull(total: number): boolean {
    return total >= MAX_ROWS;
  }

  /**
   * Turn what was read into an import, and move the watermark if — and only if —
   * the collection was read to the end.
   *
   * The order matters. The import is created first, so a crash before the
   * watermark moves means the records are imported and will be read again next
   * time; they will match the parties they created and become updates, which is
   * a re-read rather than a loss. The reverse order would move the line first
   * and lose the records if the import failed.
   */
  async finishWalk(
    organizationId: string,
    crmConnectorSyncId: string,
    drained: boolean,
  ): Promise<WalkResult> {
    const sync = await this.sync(organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    const connection = await this.connection(organizationId, sync.connectionId);
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

    /**
     * The same call a pasted file makes, with the same arguments.
     *
     * This is the ticket's "one destination" in one line: there is no connector
     * write path, there is `preview`, and everything that happens to a CSV
     * happens to these rows for the same reasons and with the same guarantees.
     */
    const preview = await this.imports.preview({
      organizationId,
      userId: connection?.userId ?? sync.connectionId.toString(),
      filename: `${sync.provider} ${sync.stream} (connected account)`,
      headers,
      rows,
    });

    /**
     * The newest modification time among records that were actually staged.
     *
     * Not the newest of the last page, and not the clock. A record the provider
     * gave no modification time for contributes nothing, so it can never push
     * the line past itself.
     */
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

  /**
   * Moves the watermark, or refuses to.
   *
   * The single place `syncedThrough` is written, so the rule lives in one
   * function that can be argued with rather than in three call sites that have
   * to agree. A walk that did not drain advances nothing and keeps its cursor; a
   * walk that drained clears the cursor, because the next walk starts a fresh
   * pass over the collection.
   */
  private async advance(
    organizationId: string,
    crmConnectorSyncId: string,
    newest: Date | null,
    drained: boolean,
  ): Promise<boolean> {
    const sync = await this.sync(organizationId, crmConnectorSyncId);
    const current = sync?.syncedThrough ?? null;
    const next = watermarkAfterWalk(current, newest, drained);

    /**
     * A walk that did not drain keeps its cursor, because the next walk
     * continues it. A walk that drained clears it, because the next walk starts
     * a fresh pass over the collection.
     */
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

  /**
   * Records a failure without touching the cursor or the watermark.
   *
   * Both omissions are the point. The cursor still points at the page that was
   * not read, so the next attempt reads it; the watermark still stands where the
   * last drain left it, so nothing is claimed to have been read that was not.
   */
  async recordFailure(
    organizationId: string,
    crmConnectorSyncId: string,
    message: string,
  ): Promise<void> {
    await this.db
      .update(crmConnectorSyncs)
      .set({
        lastRunAt: new Date(),
        lastError: message.slice(0, 500),
        consecutiveFailures: sql`${crmConnectorSyncs.consecutiveFailures} + 1`,
      })
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Where every connector on this account has got to. A pure read. */
  async progress(organizationId: string, crmConnectorSyncId: string) {
    const sync = await this.sync(organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    return {
      crmConnectorSyncId: sync.crmConnectorSyncId,
      provider: sync.provider,
      stream: sync.stream,
      enabled: sync.enabled,
      syncedThrough: sync.syncedThrough,
      /** Whether a walk is part-way through the collection. */
      resuming: sync.cursor !== null,
      staged: await this.stagedCount(organizationId, crmConnectorSyncId),
      crmImportId: sync.crmImportId,
      workflowRunId: sync.workflowRunId,
      lastRunAt: sync.lastRunAt,
      lastError: sync.lastError,
      consecutiveFailures: sync.consecutiveFailures,
    };
  }

  private async sync(organizationId: string, crmConnectorSyncId: string) {
    const [row] = await this.db
      .select()
      .from(crmConnectorSyncs)
      .where(
        and(
          eq(crmConnectorSyncs.organizationId, organizationId),
          eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The connection mirror, read and never written.
   *
   * An explicit projection rather than the row: that table is a mirror of
   * Composio's state and the connected account id is the only part of it this
   * service has any business with.
   */
  private async connection(organizationId: string, connectionId: number) {
    const [row] = await this.db
      .select({
        userId: userIntegrationConnections.userId,
        toolkit: userIntegrationConnections.toolkit,
        composioAccountId: userIntegrationConnections.composioConnectedAccountId,
        status: userIntegrationConnections.status,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.orgId, organizationId),
          eq(userIntegrationConnections.id, connectionId),
        ),
      )
      .limit(1);

    return row ?? null;
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
      // The order the provider handed them over, so the import's row numbers
      // mean something a person can follow back to the source.
      .orderBy(asc(crmConnectorRecords.stagedAt), asc(crmConnectorRecords.sourceId))
      .limit(MAX_ROWS);

    return rows.map((row) => ({
      sourceId: row.sourceId,
      modifiedAt: row.modifiedAt,
      values: row.values,
    }));
  }

  /**
   * Cleared only after the import exists.
   *
   * The staged rows are the only copy of what was read until `preview` has
   * written the plan, so clearing them first would turn a failed preview into a
   * re-read of the whole collection.
   */
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

  private inOwnTransaction<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return runInNewTenantTransaction(this.db, organizationId, () => fn());
  }
}

function settled(reason: string): WalkExtent {
  return { settled: true, reason, startAt: null, since: null };
}
