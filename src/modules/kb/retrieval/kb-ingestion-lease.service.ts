import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../../common/cache/cache.service";

const LEASE_TTL_SECONDS = 300;
const LEASE_RELEASE_SCRIPT =
  'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';

export const KB_LEASE_UNAVAILABLE_CODE = "KB_INGESTION_LEASE_UNAVAILABLE";

export type KbIngestionLease =
  | { status: "acquired"; token: string }
  | { status: "contended" }
  | { status: "unavailable"; reason: string };

export interface KbIngestionLeaseHealth {
  unavailableCount: number;
  contendedCount: number;
  lastUnavailableReason: string | null;
}

@Injectable()
export class KbIngestionLeaseService {
  private readonly logger = new Logger(KbIngestionLeaseService.name);
  private unavailableCount = 0;
  private contendedCount = 0;
  private lastUnavailableReason: string | null = null;

  constructor(
    @Optional() @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  health(): KbIngestionLeaseHealth {
    return {
      unavailableCount: this.unavailableCount,
      contendedCount: this.contendedCount,
      lastUnavailableReason: this.lastUnavailableReason,
    };
  }

  private unavailable(
    reason: string,
    context: { orgId: string; contentType: string; contentId: number },
  ): KbIngestionLease {
    this.unavailableCount += 1;
    this.lastUnavailableReason = reason;
    this.logger.error(
      `${KB_LEASE_UNAVAILABLE_CODE} — refusing KB ingestion because mutual exclusion cannot be guaranteed. Two concurrent runs would double-charge embedding credits and race the resumption checkpoints. Restore Redis and replay the dead-lettered kb.content.index events.`,
      { ...context, reason, unavailableCount: this.unavailableCount },
    );
    return { status: "unavailable", reason };
  }

  async acquire(orgId: string, contentType: string, contentId: number): Promise<KbIngestionLease> {
    const context = { orgId, contentType, contentId };
    const redis = this.redis;
    if (!redis) return this.unavailable("redis_not_configured", context);

    const key = this.leaseKey(orgId, contentType, contentId);
    const token = randomUUID();
    try {
      const result = await redis.set(key, token, { ex: LEASE_TTL_SECONDS, nx: true });
      if (result !== "OK") {
        this.contendedCount += 1;
        this.logger.warn("KB ingestion lease already held — skipping duplicate delivery", context);
        return { status: "contended" };
      }
      return { status: "acquired", token };
    } catch (err) {
      return this.unavailable(
        err instanceof Error ? err.message : String(err),
        context,
      );
    }
  }

  async release(orgId: string, contentType: string, contentId: number, token: string): Promise<void> {
    const redis = this.redis;
    if (!redis || !token) return;

    const key = this.leaseKey(orgId, contentType, contentId);
    try {
      await redis.eval<[string], number>(LEASE_RELEASE_SCRIPT, [key], [token]);
    } catch (err) {
      this.logger.warn("KB ingestion lease release failed — lease will expire naturally", {
        orgId, contentType, contentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private leaseKey(orgId: string, contentType: string, contentId: number): string {
    return `kb:ingest:lease:${orgId}:${contentType}:${contentId}`;
  }
}
