import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import { assertNever } from "../../../common/types/assert-never";
import {
  decideKbRetrievalStrategy,
  KB_CHUNK_COUNT_CACHE_TTL_SECONDS,
  KB_EXACT_SCAN_MAX_CHUNKS,
} from "./kb-retrieval-strategy";

export async function queryVectorChunkIds(
  db: Db,
  cache: CacheService | null,
  orgId: string,
  vector: string,
  cap: number,
): Promise<number[]> {
  if (!Number.isFinite(cap) || cap <= 0) return [];
  await db.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
  const strategy = decideKbRetrievalStrategy(await indexedChunkCount(db, cache, orgId), cap);
  switch (strategy.kind) {
    case "ann":
      return annChunkIds(db, orgId, vector, cap, strategy.efSearch);
    case "exact":
      return exactChunkIds(db, orgId, vector, cap);
    default:
      return assertNever(strategy);
  }
}

async function annChunkIds(db: Db, orgId: string, vector: string, cap: number, efSearch: number): Promise<number[]> {
  await db.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearch))}`);
  const rows = await db.execute(
    sql`SELECT id FROM public.kb_article_chunks
        WHERE org_id = ${orgId}
        ORDER BY embedding <=> ${vector}::vector
        LIMIT ${cap}`,
  );
  return rows.map((row) => Number(row["id"]));
}

async function exactChunkIds(db: Db, orgId: string, vector: string, cap: number): Promise<number[]> {
  const rows = await db.execute(
    sql`SELECT id FROM (
          SELECT id, embedding <=> ${vector}::vector AS distance
          FROM public.kb_article_chunks
          WHERE org_id = ${orgId}
          OFFSET 0
        ) scoped
        ORDER BY scoped.distance
        LIMIT ${cap}`,
  );
  return rows.map((row) => Number(row["id"]));
}

async function indexedChunkCount(db: Db, cache: CacheService | null, orgId: string): Promise<number> {
  const bound = KB_EXACT_SCAN_MAX_CHUNKS + 1;
  const load = async (): Promise<number> => {
    const rows = await db.execute(
      sql`SELECT count(*) AS chunk_count
          FROM (
            SELECT 1 FROM public.kb_article_chunks
            WHERE org_id = ${orgId}
            LIMIT ${bound}
          ) bounded`,
    );
    return Number(rows[0]?.["chunk_count"] ?? 0);
  };
  if (cache === null) return load();
  return cache.cachedForOrg(orgId, `kb:chunk-count:${orgId}:b${bound}`, load, KB_CHUNK_COUNT_CACHE_TTL_SECONDS);
}
