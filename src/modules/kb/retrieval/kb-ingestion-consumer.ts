import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  KbContentAdapterRegistry,
  KbPageAdapter,
  KbArticleAdapter,
  KbSourceAdapter,
  KbAttachmentAdapter,
} from "./kb-content-adapter";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { KbIngestionLeaseService } from "./kb-ingestion-lease.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { shouldDeadLetter } from "../../../common/outbox/outbox-envelope";

const KB_MAX_CONCURRENT_PER_ORG = 20;

const kbIndexPayloadSchema = z.object({
  contentType: z.string(),
  contentId: z.number().int().positive(),
  contentRevision: z.number().int().positive().optional(),
  aclRevision: z.number().int().positive().optional(),
});

@Injectable()
export class KbIngestionConsumer implements OutboxEventConsumer, OnModuleInit {
  private readonly logger = new Logger(KbIngestionConsumer.name);
  readonly eventType = "kb.content.index";

  private readonly orgConcurrency = new Map<string, number>();

  constructor(
    private readonly adapterRegistry: KbContentAdapterRegistry,
    private readonly outboxRegistry: OutboxConsumerRegistry,
    private readonly pageAdapter: KbPageAdapter,
    private readonly articleAdapter: KbArticleAdapter,
    private readonly sourceAdapter: KbSourceAdapter,
    private readonly attachmentAdapter: KbAttachmentAdapter,
    private readonly leaseService: KbIngestionLeaseService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    this.adapterRegistry.register(this.pageAdapter);
    this.adapterRegistry.register(this.articleAdapter);
    this.adapterRegistry.register(this.sourceAdapter);
    this.adapterRegistry.register(this.attachmentAdapter);
    this.outboxRegistry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const orgId = event.organizationId;
    const current = this.orgConcurrency.get(orgId) ?? 0;
    if (current >= KB_MAX_CONCURRENT_PER_ORG) {
      this.logger.warn("KB ingestion per-org concurrency limit reached", {
        orgId,
        limit: KB_MAX_CONCURRENT_PER_ORG,
        active: current,
      });
      throw new Error("KB_CONCURRENCY_LIMIT");
    }

    const payload = kbIndexPayloadSchema.parse(event.payload);
    const adapter = this.adapterRegistry.get(payload.contentType);
    if (!adapter) {
      this.logger.error("No KB content adapter for contentType", {
        orgId,
        contentType: payload.contentType,
      });
      throw new Error(`Unhandled KB content type: ${payload.contentType}`);
    }

    if (shouldDeadLetter(event.retryCount)) {
      this.logger.error("KB ingestion dead-lettered after max retries", {
        orgId,
        contentType: payload.contentType,
        contentId: payload.contentId,
        retryCount: event.retryCount,
      });
      throw new Error("KB_INGESTION_DEAD_LETTER");
    }

    this.orgConcurrency.set(orgId, current + 1);
    let leaseToken: string | undefined;
    const startMs = Date.now();

    try {
      const lease = await this.leaseService.acquire(orgId, payload.contentType, payload.contentId);
      if (!lease.acquired)
        throw new Error("KB_INGESTION_LEASE_CONTENTION");

      leaseToken = lease.token;
      this.logger.log("KB ingestion started", {
        orgId,
        contentType: payload.contentType,
        contentId: payload.contentId,
      });

      const controller = new AbortController();
      await runInNewTenantTransaction(this.db, orgId, async () => {
        await adapter.handle(orgId, payload.contentId, controller.signal);
      });
      this.logger.log("KB ingestion completed", {
        orgId,
        contentType: payload.contentType,
        contentId: payload.contentId,
        durationMs: Date.now() - startMs,
      });
    } catch (err) {
      this.logger.error("KB ingestion failed", {
        orgId,
        contentType: payload.contentType,
        contentId: payload.contentId,
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      const after = (this.orgConcurrency.get(orgId) ?? 1) - 1;
      if (after <= 0) this.orgConcurrency.delete(orgId);
      else this.orgConcurrency.set(orgId, after);
      if (leaseToken !== undefined)
        await this.leaseService.release(orgId, payload.contentType, payload.contentId, leaseToken);
    }
  }
}
