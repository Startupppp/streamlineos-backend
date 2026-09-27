import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  kbChatConversations,
  kbChatMessages,
  type KbChatRole,
  type KbChatCitation,
} from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { KbAskCitationService } from "./kb-ask-citations.service";

const MAX_PAGE = 100;

function citationKey(c: KbChatCitation): string {
  switch (c.kind) {
    case "article":
      return `a:${c.articleId}`;
    case "page":
      return `p:${c.pageId}`;
    case "source":
      return `s:${c.sourceId}`;
    case "document":
      return `d:${c.linkedDocumentId}`;
  }
}

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly citationFilter: KbAskCitationService,
  ) {}

  async append(
    user: CurrentUserContext,
    role: KbChatRole,
    content: string,
    citations?: KbChatCitation[] | null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const membershipId = actingMembershipId(user.principal) ?? 0;
    await this.db.insert(kbChatMessages).values({
      orgId: user.orgId,
      userMembershipId: membershipId,
      role,
      content: trimmed,
      citations: citations && citations.length > 0 ? citations : null,
    });
  }

  async list(
    user: CurrentUserContext,
    opts: { cursor?: number; limit: number },
  ): Promise<KbChatHistoryPage> {
    const { orgId } = user;
    const membershipId = actingMembershipId(user.principal) ?? 0;
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

    const allCitations = page.flatMap((r) => r.citations ?? []);
    const visible = await this.citationFilter.filterStoredCitations(
      user,
      allCitations,
    );
    const visibleKeys = new Set(visible.map(citationKey));

    return {
      messages: page.map((r) => {
        const raw = r.citations ?? [];
        const filtered = raw.filter((c) => visibleKeys.has(citationKey(c)));
        return {
          id: r.id,
          role: r.role,
          content: r.content,
          citations: filtered.length > 0 ? filtered : null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      nextCursor,
    };
  }

  async clear(user: CurrentUserContext): Promise<void> {
    const membershipId = actingMembershipId(user.principal) ?? 0;
    await this.db
      .delete(kbChatMessages)
      .where(
        and(
          eq(kbChatMessages.orgId, user.orgId),
          eq(kbChatMessages.userMembershipId, membershipId),
        ),
      );
  }

  async listConversations(
    user: CurrentUserContext,
    opts: { cursor?: number; limit: number; q?: string },
  ): Promise<KbConversationListPage> {
    const { orgId } = user;
    const membershipId = actingMembershipId(user.principal) ?? 0;
    const limit = Math.min(Math.max(opts.limit, 1), 50);

    let cursorRow: { updatedAt: Date; id: number } | undefined;
    if (opts.cursor) {
      const [found] = await this.db
        .select({
          updatedAt: kbChatConversations.updatedAt,
          id: kbChatConversations.id,
        })
        .from(kbChatConversations)
        .where(
          and(
            eq(kbChatConversations.id, opts.cursor),
            eq(kbChatConversations.orgId, orgId),
            eq(kbChatConversations.userMembershipId, membershipId),
          ),
        )
        .limit(1);
      cursorRow = found;
    }

    const baseConditions: SQL[] = [
      eq(kbChatConversations.orgId, orgId),
      eq(kbChatConversations.userMembershipId, membershipId),
    ];

    if (opts.q) {
      const words = opts.q
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((w) => w.length > 0)
        .slice(0, 8);
      if (words.length > 0) {
        const prefixQuery = words.map((w) => `${w}:*`).join(" & ");
        baseConditions.push(
          sql`to_tsvector('english', COALESCE(${kbChatConversations.title}, '')) @@ to_tsquery('english', ${prefixQuery})`,
        );
      }
    }

    if (cursorRow) {
      baseConditions.push(
        or(
          lt(kbChatConversations.updatedAt, cursorRow.updatedAt),
          and(
            eq(kbChatConversations.updatedAt, cursorRow.updatedAt),
            lt(kbChatConversations.id, cursorRow.id),
          ),
        ) as SQL,
      );
    }

    const rows = await this.db
      .select({
        id: kbChatConversations.id,
        title: kbChatConversations.title,
        createdAt: kbChatConversations.createdAt,
        updatedAt: kbChatConversations.updatedAt,
      })
      .from(kbChatConversations)
      .where(and(...baseConditions))
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
    user: CurrentUserContext,
    title?: string,
  ): Promise<KbConversation> {
    const membershipId = actingMembershipId(user.principal) ?? 0;
    const rows = await this.db
      .insert(kbChatConversations)
      .values({
        orgId: user.orgId,
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
    user: CurrentUserContext,
    id: number,
    title: string,
  ): Promise<KbConversation> {
    const membershipId = actingMembershipId(user.principal) ?? 0;
    const [existing] = await this.db
      .select({
        id: kbChatConversations.id,
        createdAt: kbChatConversations.createdAt,
      })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, user.orgId),
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
          eq(kbChatConversations.orgId, user.orgId),
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
    user: CurrentUserContext,
    id: number,
  ): Promise<void> {
    const membershipId = actingMembershipId(user.principal) ?? 0;
    const [existing] = await this.db
      .select({ id: kbChatConversations.id })
      .from(kbChatConversations)
      .where(
        and(
          eq(kbChatConversations.id, id),
          eq(kbChatConversations.orgId, user.orgId),
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
          eq(kbChatConversations.orgId, user.orgId),
        ),
      );
  }

  async listMessages(
    user: CurrentUserContext,
    conversationId: number,
    opts: { cursor?: number; limit: number },
  ): Promise<KbChatHistoryPage> {
    const { orgId } = user;
    const membershipId = actingMembershipId(user.principal) ?? 0;
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

    const allCitations = page.flatMap((r) => r.citations ?? []);
    const visible = await this.citationFilter.filterStoredCitations(
      user,
      allCitations,
    );
    const visibleKeys = new Set(visible.map(citationKey));

    return {
      messages: page.map((r) => {
        const raw = r.citations ?? [];
        const filtered = raw.filter((c) => visibleKeys.has(citationKey(c)));
        return {
          id: r.id,
          role: r.role,
          content: r.content,
          citations: filtered.length > 0 ? filtered : null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      nextCursor,
    };
  }

  async appendToConversation(
    user: CurrentUserContext,
    conversationId: number,
    role: KbChatRole,
    content: string,
    citations?: KbChatCitation[] | null,
  ): Promise<void> {
    const { orgId } = user;
    const membershipId = actingMembershipId(user.principal) ?? 0;
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
