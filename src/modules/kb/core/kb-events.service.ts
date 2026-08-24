import { Inject, Injectable } from "@nestjs/common";
import { kbEvents, type KbEventType } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export interface RecordKbEventOptions {
  actorId?: string | null;
  articleId?: number | null;
  query?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class KbEventsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(
    orgId: string,
    eventType: KbEventType,
    options: RecordKbEventOptions = {},
  ): Promise<void> {
    await this.db.insert(kbEvents).values({
      orgId,
      eventType,
      actorId: options.actorId ?? null,
      articleId: options.articleId ?? null,
      query: options.query ?? null,
      metadata: options.metadata ?? null,
    });
  }
}
