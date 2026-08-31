import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbIngestionCheckpoints } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

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

  async saveCheckpoint(
    orgId: string,
    contentType: string,
    contentId: number,
    contentHash: string,
    chunkIndex: number,
    content: string,
    embedding: number[],
  ): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .insert(kbIngestionCheckpoints)
        .values({
          orgId,
          contentType,
          contentId,
          contentHash,
          chunkIndex,
          content,
          embedding,
        })
        .onConflictDoUpdate({
          target: [
            kbIngestionCheckpoints.orgId,
            kbIngestionCheckpoints.contentType,
            kbIngestionCheckpoints.contentId,
            kbIngestionCheckpoints.chunkIndex,
          ],
          set: { contentHash, content, embedding },
        });
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
