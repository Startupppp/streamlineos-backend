import { ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { lockProjectTicketMutation } from "./build-ticket-mutation-policy";

export async function reserveTicketCapacity(
  tx: Db,
  orgId: string,
  projectId: number,
  incoming: readonly { status: string; count: number }[],
  excludedTicketIds: readonly number[] = [],
): Promise<void> {
  await lockProjectTicketMutation(tx, orgId, projectId);
  const counts = new Map<string, number>();
  for (const entry of incoming)
    if (entry.count > 0)
      counts.set(entry.status, (counts.get(entry.status) ?? 0) + entry.count);
  if (counts.size === 0) return;
  const values = [...counts].map(
    ([status, amount]) => sql`(${status}::text, ${amount}::integer)`,
  );
  const excluded = excludedTicketIds.length
    ? sql`AND t.id NOT IN (${sql.join(
        excludedTicketIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await tx.execute(sql`
    WITH incoming(status, amount) AS (VALUES ${sql.join(values, sql`, `)}), configured AS (
      SELECT id, name, wip_limit FROM build.project_statuses
      WHERE org_id = ${orgId} AND project_id = ${projectId}
    )
    SELECT i.status AS name, ps.wip_limit, count(t.id)::int AS current_count,
      ps.id IS NOT NULL AS status_exists
    FROM incoming i LEFT JOIN configured ps ON ps.name = i.status
    LEFT JOIN build.tickets t ON t.org_id = ${orgId} AND t.project_id = ${projectId}
      AND t.status = ps.name AND t.deleted_at IS NULL AND ps.wip_limit IS NOT NULL ${excluded}
    GROUP BY i.status, ps.id, ps.wip_limit
  `);
  for (const row of rows) {
    const name = String(row.name ?? "");
    const wipLimit = row.wip_limit != null ? Number(row.wip_limit) : null;
    const currentCount = Number(row.current_count);
    if (row.status_exists === false)
      throw new ConflictException(
        `Column '${name}' no longer exists; refresh and retry`,
      );
    if (wipLimit != null && currentCount + (counts.get(name) ?? 0) > wipLimit)
      throw new ConflictException(
        `Column '${name}' exceeds its WIP limit of ${wipLimit}`,
      );
  }
}
