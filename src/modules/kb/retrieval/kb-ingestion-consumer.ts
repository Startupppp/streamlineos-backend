import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
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
      this.logger.warn(`KB ingestion per-org concurrency limit reached (${KB_MAX_CONCURRENT_PER_ORG})`, { orgId });
      throw new Error("KB_CONCURRENCY_LIMIT");
    }

    const payload = kbIndexPayloadSchema.parse(event.payload);
    const adapter = this.adapterRegistry.get(payload.contentType);
    if (!adapter) {
      this.logger.error(`No KB content adapter for type: ${payload.contentType}`, { orgId });
      throw new Error(`Unhandled KB content type: ${payload.contentType}`);
    }

    this.orgConcurrency.set(orgId, current + 1);
    try {
      await adapter.handle(orgId, payload.contentId);
    } finally {
      const after = (this.orgConcurrency.get(orgId) ?? 1) - 1;
      if (after <= 0) this.orgConcurrency.delete(orgId);
      else this.orgConcurrency.set(orgId, after);
    }
  }
}
