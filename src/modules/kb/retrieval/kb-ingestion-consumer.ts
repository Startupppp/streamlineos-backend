import { Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { KbIndexingService } from "./kb-indexing.service";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";

const kbIndexPayloadSchema = z.object({
  contentType: z.enum(["page", "article"]),
  contentId: z.number().int().positive(),
});

@Injectable()
export class KbIngestionConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = "kb.content.index";

  constructor(
    private readonly indexing: KbIndexingService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const payload = kbIndexPayloadSchema.parse(event.payload);
    const orgId = event.organizationId;
    if (payload.contentType === "page") {
      await this.indexing.indexPage(orgId, payload.contentId);
    } else {
      await this.indexing.indexArticle(orgId, payload.contentId);
    }
  }
}
