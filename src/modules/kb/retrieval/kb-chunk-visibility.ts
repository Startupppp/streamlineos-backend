import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../db/schema";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";

export function chunkVisibleTo(standing: KbActorStanding): SQL<unknown> {
  const scope = buildVisiblePageScope(standing, "view");
  return sql`EXISTS (
    SELECT 1 FROM ${kbPages}
    WHERE ${kbPages.id} = ${kbArticleChunks.pageId}
      AND ${scope.predicate}
  )`;
}
