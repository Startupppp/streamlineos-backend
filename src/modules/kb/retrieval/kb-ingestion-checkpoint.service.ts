import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { kbIngestionCheckpoints } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const CHECKPOINT_WRITE_BATCH = 100;

@Injectable()
export class KbIngestionCheckpointService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadCheckpoints(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
  ): Promise<Map<number, number[]>> {
    const rows = await this.db
      .select({
        chunkIndex: kbIngestionCheckpoints.chunkIndex,
        embedding: kbIngestionCheckpoints.embedding,
      })
      .from(kbIngestionCheckpoints)
      .where(
        and(
          eq(kbIngestionCheckpoints.orgId, orgId),
          eq(kbIngestionCheckpoints.contentType, contentType),
          eq(kbIngestionCheckpoints.contentId, contentId),
          eq(kbIngestionCheckpoints.contentHash, contentHash),
        ),
      );

    return new Map(rows.map((r) => [r.chunkIndex, r.embedding as number[]]));
  }

  async saveCheckpoints(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    entries: { chunkIndex: number; content: string; embedding: number[] }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      for (let i = 0; i < entries.length; i += CHECKPOINT_WRITE_BATCH) {
        await tx
          .insert(kbIngestionCheckpoints)
          .values(
            entries.slice(i, i + CHECKPOINT_WRITE_BATCH).map((e) => ({
              orgId,
              contentType,
              contentId,
              contentHash,
              chunkIndex: e.chunkIndex,
              content: e.content,
              embedding: e.embedding,
            })),
          )
          .onConflictDoUpdate({
            target: [
              kbIngestionCheckpoints.orgId,
              kbIngestionCheckpoints.contentType,
              kbIngestionCheckpoints.contentId,
              kbIngestionCheckpoints.chunkIndex,
            ],
            set: {
              contentHash: sql`excluded.content_hash`,
              content: sql`excluded.content`,
              embedding: sql`excluded.embedding`,
            },
          });
      }
    });
  }

  async clearCheckpoints(
    tx: TenantTx,
    orgId: string,
    contentType: string,
    contentId: number,
  ): Promise<void> {
    await tx
      .delete(kbIngestionCheckpoints)
      .where(
        and(
          eq(kbIngestionCheckpoints.orgId, orgId),
          eq(kbIngestionCheckpoints.contentType, contentType),
          eq(kbIngestionCheckpoints.contentId, contentId),
        ),
      );
  }
}
