import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function collectSubtreeIds(
  tx: KbTransaction,
  orgId: string,
  rootIds: number | number[],
): Promise<number[]> {
  const ids = Array.isArray(rootIds) ? rootIds : [rootIds];
  if (ids.length === 0) return [];
  const rows = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, parent_page_id, 1 AS depth
      FROM kb_pages
      WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]) AND org_id = ${orgId}
      UNION ALL
      SELECT p.id, p.parent_page_id, s.depth + 1
      FROM kb_pages p
      INNER JOIN subtree s ON p.parent_page_id = s.id AND s.depth < 1000
      WHERE p.org_id = ${orgId}
    )
    SELECT id FROM subtree
  `);
  return rows.map((row) => Number(row.id));
}
