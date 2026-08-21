import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";

type Executor = Pick<Db, "execute">;

export async function allocateTicketNumbers(
  executor: Executor,
  orgId: string,
  projectId: number,
  count = 1,
): Promise<number> {
  if (count < 1) throw new Error("allocateTicketNumbers: count must be at least 1");

  const rows = await executor.execute(sql`
    INSERT INTO build.project_ticket_counters (org_id, project_id, next_ticket_number)
    VALUES (${orgId}, ${projectId}, ${count + 1})
    ON CONFLICT (org_id, project_id) DO UPDATE
      SET next_ticket_number = project_ticket_counters.next_ticket_number + ${count},
          updated_at = now()
    RETURNING next_ticket_number - ${count} AS start
  `);

  const first = rows[0]?.["start"];
  if (first === undefined || first === null)
    throw new Error("allocateTicketNumbers: counter did not return a value");
  return Number(first);
}
