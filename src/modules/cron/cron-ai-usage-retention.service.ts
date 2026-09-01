import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, lt, inArray } from "drizzle-orm";
import { Redis } from "@upstash/redis";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import { aiUsageLogs } from "../../db/schema";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

export const AI_USAGE_RETENTION_DAYS = 730;

const BATCH_SIZE = 500;
const CURSOR_TTL_SECONDS = 7 * 24 * 3600;

export interface AiUsageRetentionResult {
  dryRun: boolean;
  organizationsScanned: number;
  rowsDeleted: number;
  rowsWouldDelete: number;
}

function cursorKey(orgId: string): string {
  return `cursor:ai-usage-retention:${orgId}`;
}

@Injectable()
export class CronAiUsageRetentionService {
  private readonly logger = new Logger(CronAiUsageRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  async sweep(opts: { dryRun?: boolean } = {}): Promise<AiUsageRetentionResult> {
    const dryRun = opts.dryRun !== false;
    const cutoff = new Date(Date.now() - AI_USAGE_RETENTION_DAYS * 86_400_000);

    const result: AiUsageRetentionResult = {
      dryRun,
      organizationsScanned: 0,
      rowsDeleted: 0,
      rowsWouldDelete: 0,
    };

    const forEachResult = await forEachOrg(this.db, "ai-usage-retention", async (tx, orgId) => {
      const { deleted, wouldDelete } = await this.sweepOrg(tx, orgId, cutoff, dryRun);
      result.rowsDeleted += deleted;
      result.rowsWouldDelete += wouldDelete;
    });

    result.organizationsScanned = forEachResult.organizations;

    this.logger.log(
      `[ai-usage-retention] dryRun=${dryRun} orgs=${result.organizationsScanned} ` +
        `deleted=${result.rowsDeleted} wouldDelete=${result.rowsWouldDelete} cutoff=${cutoff.toISOString()}`,
    );

    return result;
  }

  private async sweepOrg(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
    dryRun: boolean,
  ): Promise<{ deleted: number; wouldDelete: number }> {
    let deleted = 0;
    let wouldDelete = 0;
    let cursor = await this.readCursor(orgId);

    for (;;) {
      const rows = await tx
        .select({ id: aiUsageLogs.id })
        .from(aiUsageLogs)
        .where(
          and(
            eq(aiUsageLogs.orgId, orgId),
            lt(aiUsageLogs.createdAt, cutoff),
            gt(aiUsageLogs.id, cursor),
          ),
        )
        .orderBy(asc(aiUsageLogs.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) {
        await this.resetCursor(orgId);
        break;
      }

      const ids = rows.map((r) => r.id);
      const maxId = ids[ids.length - 1] ?? cursor;

      if (dryRun) {
        wouldDelete += rows.length;
        await this.writeCursor(orgId, maxId);
        cursor = maxId;
        if (rows.length < BATCH_SIZE) {
          await this.resetCursor(orgId);
          break;
        }
        continue;
      }

      await tx.delete(aiUsageLogs).where(inArray(aiUsageLogs.id, ids));
      deleted += rows.length;
      await this.writeCursor(orgId, maxId);
      cursor = maxId;

      if (rows.length < BATCH_SIZE) {
        await this.resetCursor(orgId);
        break;
      }
    }

    return { deleted, wouldDelete };
  }

  private async readCursor(orgId: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      const val = await this.redis.get<number>(cursorKey(orgId));
      return typeof val === "number" ? val : 0;
    } catch {
      return 0;
    }
  }

  private async writeCursor(orgId: string, id: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(cursorKey(orgId), id, { ex: CURSOR_TTL_SECONDS });
    } catch {
      this.logger.warn(`[ai-usage-retention] failed to persist cursor for org ${orgId}`);
    }
  }

  private async resetCursor(orgId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(cursorKey(orgId));
    } catch {
      this.logger.warn(`[ai-usage-retention] failed to reset cursor for org ${orgId}`);
    }
  }
}
