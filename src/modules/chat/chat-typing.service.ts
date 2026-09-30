import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { and, eq } from "drizzle-orm";
import { chatChannelMembers, chatChannels, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";

interface TypingEntry {
  name: string;
  expiresAt: number;
}

const TYPING_TTL_MS = 4_000;
const KEY_TTL_SECONDS = 10;

@Injectable()
export class ChatTypingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  // ponytail: in-process fallback when Upstash is absent — typers are visible only to
  // requests served by the same instance. Configure REDIS for multi-instance deployments.
  private readonly local = new Map<string, { entries: Record<string, TypingEntry>; expiresAt: number }>();

  private key(channelId: number): string {
    return `chat:typing:${channelId}`;
  }

  /**
   * The channel is resolved under the caller's organization BEFORE membership is considered.
   *
   * This used to go straight to `chat_channel_members`, so another organization's `channelId`
   * produced the same `ForbiddenException` a same-org non-member gets. Measured by the live
   * cross-tenant sweep on both `/chat/channels/:channelId/typing` verbs: cross-tenant 403 — the
   * existence oracle backend/CLAUDE.md §4 forbids, and the one status a cross-tenant miss may
   * never return.
   *
   * The order and the two refusals mirror `ChatChannelMembersImplementation.assertChannelMembership` and
   * `ChatReactionsService.assertChannelMember`, which the module already had right: 404 when the
   * caller's organization holds no such channel, 404 when it is private and the caller is not in
   * it (a private channel must not confirm its own existence), and 403 only for a genuine same-org
   * non-member of a channel that is not private.
   */
  private async assertChannelMember(channelId: number, orgId: string, userId: string): Promise<void> {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { id: true, isPrivate: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const orgMember = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    const membership = orgMember
      ? await this.db.query.chatChannelMembers.findFirst({
          where: and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            eq(chatChannelMembers.membershipId, orgMember.id),
          ),
          columns: { id: true },
        })
      : null;
    if (!membership) {
      if (channel.isPrivate) throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }
  }

  async setTyping(channelId: number, orgId: string, userId: string): Promise<void> {
    await this.assertChannelMember(channelId, orgId, userId);

    const me = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    });

    const entry: TypingEntry = {
      name: me?.name ?? "Someone",
      expiresAt: Date.now() + TYPING_TTL_MS,
    };

    const key = this.key(channelId);
    if (!this.redis) {
      const now = Date.now();
      for (const [k, v] of this.local) if (v.expiresAt <= now) this.local.delete(k);
      const entries = { ...this.local.get(key)?.entries, [userId]: entry };
      this.local.set(key, { entries, expiresAt: now + KEY_TTL_SECONDS * 1_000 });
      return;
    }
    try {
      await this.redis.hset(key, { [userId]: entry });
      await this.redis.expire(key, KEY_TTL_SECONDS);
    } catch {
      return;
    }
  }

  async getTyping(channelId: number, orgId: string, currentUserId: string) {
    await this.assertChannelMember(channelId, orgId, currentUserId);

    let state: Record<string, TypingEntry> | null;
    try {
      state = this.redis
        ? await this.redis.hgetall<Record<string, TypingEntry>>(this.key(channelId))
        : (this.local.get(this.key(channelId))?.entries ?? null);
    } catch {
      return [];
    }
    if (!state) return [];

    const now = Date.now();
    const typers: { userId: string; name: string }[] = [];
    for (const [uid, entry] of Object.entries(state)) {
      if (uid !== currentUserId && entry.expiresAt > now) {
        typers.push({ userId: uid, name: entry.name });
      }
    }
    return typers;
  }
}
