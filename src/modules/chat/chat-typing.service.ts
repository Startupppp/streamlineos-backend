import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import { assertChannelMember } from "./chat-channel-authorization";

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

  private readonly local = new Map<string, { entries: Record<string, TypingEntry>; expiresAt: number }>();

  private key(channelId: number): string {
    return `chat:typing:${channelId}`;
  }

  async setTyping(channelId: number, orgId: string, userId: string): Promise<void> {
    await assertChannelMember(this.db, channelId, userId, orgId);

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
    await assertChannelMember(this.db, channelId, currentUserId, orgId);

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
