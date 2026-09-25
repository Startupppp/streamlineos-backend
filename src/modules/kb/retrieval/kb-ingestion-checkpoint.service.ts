import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { kbIngestionCheckpoints } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";

const CHECKPOINT_WRITE_BATCH = 100;

function checkpointHash(contentHash: string): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}\u0000${contentHash}`).digest("hex");
}

@Injectable()
export class KbIngestionCheckpointService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadCheckpoints(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
  ): Promise<Map<number, number[]>> {
    const rows = await runInTenantTransaction(
      this.db,
      async (tx) =>
        tx
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
              eq(kbIngestionCheckpoints.contentHash, checkpointHash(contentHash)),
            ),
          ),
      { orgId },
    );

    return new Map(rows.map((r) => [r.chunkIndex, r.embedding]));
  }

  async saveCheckpoints(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    entries: { chunkIndex: number; content: string; embedding: number[] }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const storedHash = checkpointHash(contentHash);
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      for (let i = 0; i < entries.length; i += CHECKPOINT_WRITE_BATCH) {
        await tx
          .insert(kbIngestionCheckpoints)
          .values(
            entries.slice(i, i + CHECKPOINT_WRITE_BATCH).map((e) => ({
              orgId,
              contentType,
              contentId,
              contentHash: storedHash,
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
