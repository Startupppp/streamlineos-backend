import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { kbArticleChunks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { type TenantTx } from "../../../db/drizzle.types";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const kbDeletePayloadSchema = z.object({
  contentType: z.enum(["page", "article", "source", "attachment"]),
  contentId: z.number().int().positive(),
});

@Injectable()
export class KbIngestionDeleteConsumer implements OutboxEventConsumer, OnModuleInit {
  private readonly logger = new Logger(KbIngestionDeleteConsumer.name);
  readonly eventType = "kb.content.delete";

  constructor(
    private readonly outboxRegistry: OutboxConsumerRegistry,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    this.outboxRegistry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const orgId = event.organizationId;
    const payload = kbDeletePayloadSchema.parse(event.payload);

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await this.purgeChunks(tx, orgId, payload.contentType, payload.contentId);
    });

    this.logger.log("KB chunks purged for deleted content", {
      orgId,
      contentType: payload.contentType,
      contentId: payload.contentId,
    });
  }

  private async purgeChunks(
    tx: TenantTx,
    orgId: string,
    contentType: "page" | "article" | "source" | "attachment",
    contentId: number,
  ): Promise<void> {
    switch (contentType) {
      case "page":
      case "article":
        await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              eq(kbArticleChunks.pageId, contentId),
            ),
          );
        return;
      case "source":
        await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              eq(kbArticleChunks.sourceId, contentId),
            ),
          );
        return;
      case "attachment":
        await tx
          .delete(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, orgId),
              eq(kbArticleChunks.attachmentId, contentId),
            ),
          );
        return;
    }
  }
}
