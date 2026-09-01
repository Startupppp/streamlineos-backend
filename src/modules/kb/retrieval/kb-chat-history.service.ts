import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  kbChatConversations,
  kbChatMessages,
  type KbChatRole,
  type KbChatCitation,
} from "../../../db/schema";

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

export interface KbConversation {
  id: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbConversationListPage {
  conversations: KbConversation[];
  nextCursor: number | null;
}

@Injectable()
export class KbChatHistoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async append(
    orgId: string,
    _userId: string,
    membershipId: number,
    role: KbChatRole,
    content: string,
    citations?: KbChatCitation[] | null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await this.db.insert(kbChatMessages).values({
      orgId,
      userMembershipId: membershipId,
      role,
      content: trimmed,
      citations: citations && citations.length > 0 ? citations : null,
    });
  }

  async list(
    orgId: string,
    _userId: string,
    membershipId: number,
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
          eq(kbChatMessages.userMembershipId, membershipId),
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

  async clear(
    orgId: string,
    _userId: string,
    membershipId: number,
  ): Promise<void> {
    await this.db
      .delete(kbChatMessages)
      .where(
        and(
          eq(kbChatMessages.orgId, orgId),
          eq(kbChatMessages.userMembershipId, membershipId),
        ),
      );
  }

  async listConversations(
    orgId: string,
    _userId: string,
    membershipId: number,
    opts: { cursor?: number; limit: number },
  ): Promise<KbConversationListPage> {
    const limit = Math.min(Math.max(opts.limit, 1), 50);

    let cursorRow: { updatedAt: Date; id: number } | undefined;
    if (opts.cursor) {
      const [found] = await this.db
        .select({
          updatedAt: kbChatConversations.updatedAt,
          id: kbChatConversations.id,
        })
        .from(kbChatConversations)
        .where(eq(kbChatConversations.id, opts.cursor))
        .limit(1);
      cursorRow = found;
    }

    const rows = await this.db
      .select({
        id: kbChatConversations.id,
        title: kbChatConversations.title,
        createdAt: kbChatConversations.createdAt,
        updatedAt: kbChatConversations.updatedAt,
      })
      .from(kbChatConversations)
      .where(
        cursorRow
          ? and(
              eq(kbChatConversations.orgId, orgId),
              eq(kbChatConversations.userMembershipId, membershipId),
              or(
                lt(kbChatConversations.updatedAt, cursorRow.updatedAt),
                and(
                  eq(kbChatConversations.updatedAt, cursorRow.updatedAt),
                  lt(kbChatConversations.id, cursorRow.id),
                ),
              ),
            )
          : and(
              eq(kbChatConversations.orgId, orgId),
              eq(kbChatConversations.userMembershipId, membershipId),
            ),
      )
      .orderBy(
        desc(kbChatConversations.updatedAt),
        desc(kbChatConversations.id),
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? last.id : null;

    return {
      conversations: page.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async createConversation(
    orgId: string,
    _userId: string,
    membershipId: number,
    title?: string,
  ): Promise<KbConversation> {
    const rows = await this.db
      .insert(kbChatConversations)
      .values({
        orgId,
        userMembershipId: membershipId,
        title: title ?? null,
      })
      .returning();
    const conv = rows[0];
    if (!conv) throw new Error("Failed to create conversation");
    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    };
  }

  async renameConversation(
    orgId: string,
    _userId: string,
    membershipId: number,
    id: number,
    title: string,
  ): Promise<KbConversation> {
    const [existing] = await this.db
      .select({
        id: kbChatConversations.id,
        createdAt: kbChatConversations.createdAt,
      })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, orgId),
          eq(kbChatConversations.userMembershipId, membershipId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Conversation not found");

    const now = new Date();
    await this.db
      .update(kbChatConversations)
      .set({ title, updatedAt: now })
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, orgId),
        ),
      );

    return {
      id: existing.id,
      title,
      createdAt: existing.createdAt.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  async deleteConversation(
    orgId: string,
    _userId: string,
    membershipId: number,
    id: number,
  ): Promise<void> {
    const [existing] = await this.db
      .select({ id: kbChatConversations.id })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, orgId),
          eq(kbChatConversations.userMembershipId, membershipId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Conversation not found");

    await this.db
      .delete(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, orgId),
        ),
      );
  }

  async listMessages(
    orgId: string,
    _userId: string,
    membershipId: number,
    conversationId: number,
    opts: { cursor?: number; limit: number },
  ): Promise<KbChatHistoryPage> {
    const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);

    const [conv] = await this.db
      .select({ id: kbChatConversations.id })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, conversationId),
          eq(kbChatConversations.orgId, orgId),
          eq(kbChatConversations.userMembershipId, membershipId),
        ),
      )
      .limit(1);

    if (!conv) throw new NotFoundException("Conversation not found");

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
          eq(kbChatMessages.conversationId, conversationId),
          eq(kbChatMessages.orgId, orgId),
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

  async appendToConversation(
    orgId: string,
    _userId: string,
    membershipId: number,
    conversationId: number,
    role: KbChatRole,
    content: string,
    citations?: KbChatCitation[] | null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    await this.db.insert(kbChatMessages).values({
      orgId,
      userMembershipId: membershipId,
      role,
      content: trimmed,
      citations: citations && citations.length > 0 ? citations : null,
      conversationId,
    });

    const now = new Date();
    const [conv] = await this.db
      .select({ title: kbChatConversations.title })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, conversationId),
          eq(kbChatConversations.orgId, orgId),
        ),
      )
      .limit(1);

    if (conv && conv.title === null && role === "user") {
      await this.db
        .update(kbChatConversations)
        .set({ title: trimmed.substring(0, 60).trim(), updatedAt: now })
        .where(
          and(
            eq(kbChatConversations.id, conversationId),
            eq(kbChatConversations.orgId, orgId),
          ),
        );
    } else {
      await this.db
        .update(kbChatConversations)
        .set({ updatedAt: now })
        .where(
          and(
            eq(kbChatConversations.id, conversationId),
            eq(kbChatConversations.orgId, orgId),
          ),
        );
    }
  }
}
