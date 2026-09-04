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

/**
 * What a stored vector is really keyed by.
 *
 * A checkpoint row holds a vector, and a vector belongs to the model that produced it —
 * but `kb_ingestion_checkpoints` has no `embedding_model` column and its natural key is
 * `(org_id, content_type, content_id, chunk_index)`. So an ingestion interrupted before a
 * model upgrade left checkpoints in the old vector space; the retry after the upgrade hit
 * on `content_hash` (the text had not changed), reused those vectors, and
 * `replacePageBodyChunks` stamped them with the *current* `EMBEDDING_MODEL`. Cosine
 * distance across two embedding spaces is noise, and the partial unique index on
 * `(…, embedding_model)` considers the result well-formed.
 *
 * Folding the model into the stored hash fixes that without a schema change: a checkpoint
 * written by one model simply cannot be found by another, so it is re-embedded rather than
 * reused. Callers keep passing the plain `sha256(text)` — the model is the store's business,
 * and the chunk rows' own `content_hash` (which drives the skip-if-unchanged short-circuit,
 * and would force a full re-embed of every tenant if it moved) is untouched.
 */
function checkpointHash(contentHash: string): string {
  // A NUL separator, written as the escape rather than as a literal NUL byte: a raw NUL in
  // the source makes git call this file binary ("Binary files … differ") and `file` call it
  // data, which is how it arrived. The separator itself is load-bearing — a model name cannot
  // contain NUL, so no (model, hash) pair can collide with a different one by concatenation.
  return createHash("sha256").update(`${EMBEDDING_MODEL}\u0000${contentHash}`).digest("hex");
}

@Injectable()
export class KbIngestionCheckpointService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The read needs its own tenant transaction for the same reason `saveCheckpoints`
   * already had one, and it is the half that was missed.
   *
   * `kb_ingestion_checkpoints` is RLS-enabled under `org_id = current_org_id()` — the
   * RAISING variant, not `_or_null`. Both reindex routes carry `@NoTenantTransaction()`
   * so they can await embedding round trips without pinning a pooled connection, which
   * means there is no ambient context for the `DRIZZLE` proxy to borrow and this
   * `select` reached the pool with no tenant GUC: `POST /kb/pages/:pageId/reindex` and
   * `POST /kb/pages/reindex-all` both died 42501 on the FIRST statement `indexPage`
   * issues after resolving the page, so no reindex could be requested at all.
   *
   * `runInTenantTransaction` with an explicit orgId reuses an ambient transaction where
   * there is one (the outbox-driven indexing callers) and opens a short one where there
   * is not, so both entry paths keep working and neither holds a connection across an
   * embedding call.
   */
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
