import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../../common/cache/cache.service";

const LEASE_TTL_SECONDS = 300;
const LEASE_RELEASE_SCRIPT =
  'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';

export interface KbIngestionLease {
  token: string;
  acquired: boolean;
}

@Injectable()
export class KbIngestionLeaseService {
  private readonly logger = new Logger(KbIngestionLeaseService.name);

  constructor(
    @Optional() @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  async acquire(orgId: string, contentType: string, contentId: number): Promise<KbIngestionLease> {
    const redis = this.redis;
    if (!redis) return { token: "", acquired: true };

    const key = this.leaseKey(orgId, contentType, contentId);
    const token = randomUUID();
    try {
      const result = await redis.set(key, token, { ex: LEASE_TTL_SECONDS, nx: true });
      const acquired = result === "OK";
      if (!acquired)
        this.logger.warn("KB ingestion lease already held — skipping duplicate delivery", {
          orgId, contentType, contentId,
        });
      return { token, acquired };
    } catch (err) {
      this.logger.warn("KB ingestion lease acquire failed — proceeding without lease", {
        orgId, contentType, contentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { token: "", acquired: true };
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
