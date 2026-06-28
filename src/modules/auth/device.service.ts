import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { devices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";

@Injectable()
export class DeviceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async findOrCreate(params: {
    userId: string;
    fingerprint: string;
    browser?: string;
    os?: string;
    platform?: string;
  }): Promise<{ id: string; trusted: boolean }> {
    const existing = await this.db.query.devices.findFirst({
      where: and(eq(devices.userId, params.userId), eq(devices.fingerprint, params.fingerprint)),
    });

    if (existing) {
      await this.db
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(devices.userId, params.userId), eq(devices.fingerprint, params.fingerprint)));
      return { id: existing.id, trusted: existing.trusted };
    }

    const id = randomUUID();
    await this.db.insert(devices).values({
      id,
      userId: params.userId,
      fingerprint: params.fingerprint,
      browser: params.browser,
      os: params.os,
      platform: params.platform,
      trusted: false,
    });
    await this.cache.invalidate(`devices:${params.userId}`);
    return { id, trusted: false };
  }

  async list(userId: string) {
    return this.cache.cached(
      `devices:${userId}`,
      () => this.db.query.devices.findMany({ where: eq(devices.userId, userId), orderBy: (t, { desc }) => [desc(t.lastSeenAt)] }),
      60,
    );
  }

  async trust(id: string, userId: string): Promise<void> {
    await this.db.update(devices).set({ trusted: true }).where(and(eq(devices.id, id), eq(devices.userId, userId)));
    await this.cache.invalidate(`devices:${userId}`);
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.db.delete(devices).where(and(eq(devices.id, id), eq(devices.userId, userId)));
    await this.cache.invalidate(`devices:${userId}`);
  }
}
