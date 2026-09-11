import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../../common/cache/cache.service";
import { OUTBOX_LEASE_MS } from "../../../common/outbox/outbox-claim";

const LEASE_EXPIRY_MARGIN_MS = 10_000;

export const KB_LEASE_TTL_MS = Math.max(1_000, OUTBOX_LEASE_MS - LEASE_EXPIRY_MARGIN_MS);
export const KB_LEASE_TTL_SECONDS = Math.max(1, Math.floor(KB_LEASE_TTL_MS / 1_000));
export const KB_LEASE_HEARTBEAT_MS = Math.max(1_000, Math.floor(KB_LEASE_TTL_MS / 3));

if (KB_LEASE_TTL_SECONDS * 1_000 >= OUTBOX_LEASE_MS) {
  throw new Error(
    `KB ingestion lease TTL (${KB_LEASE_TTL_SECONDS}s) must expire strictly before the outbox ` +
      `re-claims an event (${OUTBOX_LEASE_MS}ms). A longer TTL means a crashed worker's own lease ` +
      `is still held when its event is redelivered, so the redelivery sees contention forever.`,
  );
}

const LEASE_RELEASE_SCRIPT =
  'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';
const LEASE_RENEW_SCRIPT =
  'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("expire",KEYS[1],ARGV[2]) else return 0 end';

export const KB_LEASE_UNAVAILABLE_CODE = "KB_INGESTION_LEASE_UNAVAILABLE";
export const KB_LEASE_CONTENDED_CODE = "KB_INGESTION_LEASE_CONTENDED";
export const KB_LEASE_LOST_CODE = "KB_INGESTION_LEASE_LOST";

export type KbIngestionLease =
  | { status: "acquired"; token: string }
  | { status: "contended" }
  | { status: "unavailable"; reason: string };

export type KbIngestionLeaseRenewal =
  | { status: "renewed" }
  | { status: "lost" }
  | { status: "unavailable"; reason: string };

export interface KbIngestionLeaseHealth {
  unavailableCount: number;
  contendedCount: number;
  lostCount: number;
  lastUnavailableReason: string | null;
}

export interface KbIngestionLeaseHeartbeat {
  stop(): void;
  lost(): boolean;
}

@Injectable()
export class KbIngestionLeaseService {
  private readonly logger = new Logger(KbIngestionLeaseService.name);
  private unavailableCount = 0;
  private contendedCount = 0;
  private lostCount = 0;
  private lastUnavailableReason: string | null = null;

  constructor(
    @Optional() @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  health(): KbIngestionLeaseHealth {
    return {
      unavailableCount: this.unavailableCount,
      contendedCount: this.contendedCount,
      lostCount: this.lostCount,
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
      const result = await redis.set(key, token, { ex: KB_LEASE_TTL_SECONDS, nx: true });
      if (result !== "OK") {
        this.contendedCount += 1;
        this.logger.warn(
          `${KB_LEASE_CONTENDED_CODE} — another worker holds this document; the event is not delivered and will be retried`,
          context,
        );
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

  async renew(
    orgId: string,
    contentType: string,
    contentId: number,
    token: string,
  ): Promise<KbIngestionLeaseRenewal> {
    const redis = this.redis;
    if (!redis || !token) return { status: "unavailable", reason: "redis_not_configured" };

    const key = this.leaseKey(orgId, contentType, contentId);
    try {
      const extended = await redis.eval<[string, string], number>(
        LEASE_RENEW_SCRIPT,
        [key],
        [token, String(KB_LEASE_TTL_SECONDS)],
      );
      if (extended === 1) return { status: "renewed" };
      this.lostCount += 1;
      this.logger.error(`${KB_LEASE_LOST_CODE} — this worker no longer holds the lease it is running under`, {
        orgId,
        contentType,
        contentId,
      });
      return { status: "lost" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn("KB ingestion lease renewal failed — retrying on the next heartbeat", {
        orgId,
        contentType,
        contentId,
        reason,
      });
      return { status: "unavailable", reason };
    }
  }

  startHeartbeat(
    orgId: string,
    contentType: string,
    contentId: number,
    token: string,
  ): KbIngestionLeaseHeartbeat {
    let lost = false;
    const timer = setInterval(() => {
      void this.renew(orgId, contentType, contentId, token).then((outcome) => {
        if (outcome.status === "lost") lost = true;
      });
    }, KB_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return {
      stop: () => clearInterval(timer),
      lost: () => lost,
    };
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
