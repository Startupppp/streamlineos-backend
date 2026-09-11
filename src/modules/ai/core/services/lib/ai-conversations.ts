import { NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { type Db } from "../../../../../db/drizzle.module";
import { aiChatConversations } from "../../../../../db/schema";
import type { AiConversation, AiConversationListPage } from "../chat-history.service";

/**
 * The conversations themselves: list, open, rename, delete.
 *
 * Split from the MESSAGES in them because the ownership rule lives here and
 * only here. Every one of these gates on `(org, membership)` before it touches
 * a row, so a conversation belongs to the membership that opened it rather than
 * to the org — which is why the message functions next door can take a
 * conversation id and not re-derive that.
 *
 * Plain `db` parameters rather than a deps bag: this service injects nothing
 * else.
 */

export async function listConversations(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  opts: { cursor?: number; limit: number },
): Promise<AiConversationListPage> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);

  let cursorRow: { updatedAt: Date; id: number } | undefined;
  if (opts.cursor) {
    const [found] = await db
      .select({ updatedAt: aiChatConversations.updatedAt, id: aiChatConversations.id })
      .from(aiChatConversations)
      .where(eq(aiChatConversations.id, opts.cursor))
      .limit(1);
    cursorRow = found;
  }

  const rows = await db
    .select({
      id: aiChatConversations.id,
      title: aiChatConversations.title,
      createdAt: aiChatConversations.createdAt,
      updatedAt: aiChatConversations.updatedAt,
    })
    .from(aiChatConversations)
    .where(
      cursorRow
        ? and(
            eq(aiChatConversations.orgId, orgId),
            eq(aiChatConversations.userMembershipId, membershipId),
            or(
              lt(aiChatConversations.updatedAt, cursorRow.updatedAt),
              and(
                eq(aiChatConversations.updatedAt, cursorRow.updatedAt),
                lt(aiChatConversations.id, cursorRow.id),
              ),
            ),
          )
        : and(eq(aiChatConversations.orgId, orgId), eq(aiChatConversations.userMembershipId, membershipId)),
    )
    .orderBy(desc(aiChatConversations.updatedAt), desc(aiChatConversations.id))
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

export async function createConversation(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  title?: string,
): Promise<AiConversation> {
  const rows = await db
    .insert(aiChatConversations)
    .values({ orgId, userId, userMembershipId: membershipId, title: title ?? null })
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

export async function renameConversation(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  id: number,
  title: string,
): Promise<AiConversation> {
  const [existing] = await db
    .select({
      id: aiChatConversations.id,
      createdAt: aiChatConversations.createdAt,
    })
    .from(aiChatConversations)
    .where(
      and(
        eq(aiChatConversations.id, id),
        eq(aiChatConversations.orgId, orgId),
        eq(aiChatConversations.userMembershipId, membershipId),
      ),
    )
    .limit(1);

  if (!existing) throw new NotFoundException("Conversation not found");

  const now = new Date();
  await db
    .update(aiChatConversations)
    .set({ title, updatedAt: now })
    .where(eq(aiChatConversations.id, id));

  return {
    id: existing.id,
    title,
    createdAt: existing.createdAt.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteConversation(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number,
  id: number,
): Promise<void> {
  const [existing] = await db
    .select({ id: aiChatConversations.id })
    .from(aiChatConversations)
    .where(
      and(
        eq(aiChatConversations.id, id),
        eq(aiChatConversations.orgId, orgId),
        eq(aiChatConversations.userMembershipId, membershipId),
      ),
    )
    .limit(1);

  if (!existing) throw new NotFoundException("Conversation not found");

  await db.delete(aiChatConversations).where(eq(aiChatConversations.id, id));
}
