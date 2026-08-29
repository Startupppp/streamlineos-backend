import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { and, eq } from "drizzle-orm";
import { chatChannelMembers, users } from "../../db/schema";
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

  private key(channelId: number): string {
    return `chat:typing:${channelId}`;
  }

  private async assertChannelMember(channelId: number, userId: string): Promise<void> {
    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
      columns: { id: true },
    });
    if (!membership) throw new ForbiddenException("You are not a member of this channel");
  }

  async setTyping(channelId: number, userId: string): Promise<void> {
    await this.assertChannelMember(channelId, userId);
    if (!this.redis) return;

    const me = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    });

    const entry: TypingEntry = {
      name: me?.name ?? "Someone",
      expiresAt: Date.now() + TYPING_TTL_MS,
    };

    const key = this.key(channelId);
    try {
      await this.redis.hset(key, { [userId]: entry });
      await this.redis.expire(key, KEY_TTL_SECONDS);
    } catch {
      return;
    }
  }

  async getTyping(channelId: number, currentUserId: string) {
    await this.assertChannelMember(channelId, currentUserId);
    if (!this.redis) return [];

    let state: Record<string, TypingEntry> | null;
    try {
      state = await this.redis.hgetall<Record<string, TypingEntry>>(this.key(channelId));
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
