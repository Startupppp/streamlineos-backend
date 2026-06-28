import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";

@Injectable()
export class SessionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async create(params: {
    userId: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
    expiresAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(userSessions).values({
      id,
      userId: params.userId,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      deviceId: params.deviceId,
      expiresAt: params.expiresAt,
      isRevoked: false,
      lastActive: new Date(),
    });
    return id;
  }

  async listActive(userId: string) {
    const now = new Date();
    return this.db.query.userSessions.findMany({
      where: and(
        eq(userSessions.userId, userId),
        eq(userSessions.isRevoked, false),
        or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, now)),
      ),
      columns: {
        id: true,
        userId: true,
        userAgent: true,
        ipAddress: true,
        deviceId: true,
        lastActive: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: (t, { desc }) => [desc(t.lastActive)],
    });
  }

  async revoke(id: string, userId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId)));
    await this.cache.invalidate(`session:${userId}`);
  }

  async revokeAll(userId: string, exceptId?: string): Promise<void> {
    const conditions = [eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)];
    if (exceptId) {
      const { ne } = await import("drizzle-orm");
      conditions.push(ne(userSessions.id, exceptId));
    }
    await this.db.update(userSessions).set({ isRevoked: true }).where(and(...conditions));
    await this.cache.invalidate(`session:${userId}`);
  }

  async touch(id: string): Promise<void> {
    await this.db.update(userSessions).set({ lastActive: new Date() }).where(eq(userSessions.id, id));
  }

  async enforceMaxSessions(userId: string, maxAllowed: number, keepId: string): Promise<void> {
    const now = new Date();
    const active = await this.db
      .select({ id: userSessions.id, lastActive: userSessions.lastActive })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isRevoked, false),
          or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, now)),
        ),
      )
      .orderBy(asc(userSessions.lastActive));

    if (active.length <= maxAllowed) return;

    const toRevoke = active
      .filter((s) => s.id !== keepId)
      .slice(0, active.length - maxAllowed);

    if (toRevoke.length === 0) return;

    for (const s of toRevoke) {
      await this.db
        .update(userSessions)
        .set({ isRevoked: true })
        .where(eq(userSessions.id, s.id));
    }
    await this.cache.invalidate(`session:${userId}`);
  }

  async isValid(id: string, userId: string): Promise<boolean> {
    const now = new Date();
    const session = await this.db.query.userSessions.findFirst({
      where: and(
        eq(userSessions.id, id),
        eq(userSessions.userId, userId),
        eq(userSessions.isRevoked, false),
        or(isNull(userSessions.expiresAt), gt(userSessions.expiresAt, now)),
      ),
    });
    return !!session;
  }
}
