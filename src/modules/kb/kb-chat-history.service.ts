import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbChatMessages, type KbChatRole, type KbChatCitation } from "../../db/schema";

const MAX_PAGE = 100;

export interface KbChatHistoryMessage {
  id: number;
  role: KbChatRole;
  content: string;
  citations: KbChatCitation[] | null;
  createdAt: string;
}

export interface KbChatHistoryPage {
  messages: KbChatHistoryMessage[];
  nextCursor: number | null;
}

@Injectable()
export class KbChatHistoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async append(
    orgId: string,
    userId: string,
    role: KbChatRole,
    content: string,
    citations?: KbChatCitation[] | null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await this.db.insert(kbChatMessages).values({
      orgId,
      userId,
      role,
      content: trimmed,
      citations: citations && citations.length > 0 ? citations : null,
    });
  }

  async list(
    orgId: string,
    userId: string,
    opts: { cursor?: number; limit: number },
  ): Promise<KbChatHistoryPage> {
    const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);
    const rows = await this.db
      .select({
        id: kbChatMessages.id,
        role: kbChatMessages.role,
        content: kbChatMessages.content,
        citations: kbChatMessages.citations,
        createdAt: kbChatMessages.createdAt,
      })
      .from(kbChatMessages)
      .where(
        and(
          eq(kbChatMessages.orgId, orgId),
          eq(kbChatMessages.userId, userId),
          opts.cursor ? lt(kbChatMessages.id, opts.cursor) : undefined,
        ),
      )
      .orderBy(desc(kbChatMessages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? last.id : null;

    return {
      messages: page.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        citations: r.citations ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async clear(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(kbChatMessages)
      .where(and(eq(kbChatMessages.orgId, orgId), eq(kbChatMessages.userId, userId)));
  }
}
