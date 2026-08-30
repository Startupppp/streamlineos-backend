import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmConnectorRecords, crmConnectorSyncs, workflowRuns } from "../../../db/schema";
import { WorkflowRunnerService } from "../../../common/workflow";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { connectorFor, streamFor } from "./connectors/connector-catalog";
import { type ConnectorProvider, type ConnectorStream } from "./connectors/connector-source";
import { CONNECTOR_SYNC_WORKFLOW } from "./import-workflow-names";
import { getSync, getConnection } from "./crm-connector-internals";

@Injectable()
export class CrmConnectorLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflows: WorkflowRunnerService,
  ) {}

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
        `${input.provider} ${input.stream} records map onto ${descriptor.target}, which a connected ` +
          "account cannot land on its own — a subject import has to be told which subject type the " +
          "records are, and nothing in the provider's payload says. Paste the export instead, where " +
          "you can choose one.",
      );

    return runInNewTenantTransaction(this.db, input.organizationId, async () => {
      const connection = await getConnection(this.db, input.organizationId, input.connectionId);
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.userId !== input.userId)
        throw new NotFoundException("Connection not found");

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

  async progress(organizationId: string, crmConnectorSyncId: string) {
    const sync = await getSync(this.db, organizationId, crmConnectorSyncId);
    if (!sync) throw new NotFoundException("Connector sync not found");

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(crmConnectorRecords)
      .where(
        and(
          eq(crmConnectorRecords.organizationId, organizationId),
          eq(crmConnectorRecords.crmConnectorSyncId, crmConnectorSyncId),
        ),
      );

    return {
      crmConnectorSyncId: sync.crmConnectorSyncId,
      provider: sync.provider,
      stream: sync.stream,
      enabled: sync.enabled,
      syncedThrough: sync.syncedThrough,
      resuming: sync.cursor !== null,
      staged: countRow?.count ?? 0,
      crmImportId: sync.crmImportId,
      workflowRunId: sync.workflowRunId,
      lastRunAt: sync.lastRunAt,
      lastError: sync.lastError,
      consecutiveFailures: sync.consecutiveFailures,
    };
  }
}
