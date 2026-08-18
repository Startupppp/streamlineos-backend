import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";

type Executor = Pick<Db, "execute">;

/**
 * Allocate `count` consecutive ticket numbers for a project.
 *
 * Replaces `COALESCE(MAX(ticket_number),0)+1`, which was wrong in two ways: it cost an index scan
 * that grew with the project, and it raced. Only one of the six call sites held
 * `pg_advisory_xact_lock(projectId)`; the rest could compute the same number concurrently and
 * collide on `uniq_tickets_project_number`.
 *
 * The upsert takes a single row lock for the duration of one statement, so two creators in the same
 * project serialise for microseconds instead of for the whole transaction, and the cost is constant
 * regardless of how many tickets exist. `ON CONFLICT` also self-heals a project whose counter row is
 * missing, which keeps this safe for projects created before migration 0430.
 *
 * Returns the FIRST number of the block; the caller uses `start … start + count - 1`.
 *
 * Numbers are monotonic, not gap-free: a transaction that aborts after allocating leaves its number
 * unused. That is deliberate — reissuing a number would let a deleted ticket's identifier reappear on
 * a different ticket, and PROJ-123 is a durable human reference that turns up in commits and chat.
 */
export async function allocateTicketNumbers(
  executor: Executor,
  orgId: string,
  projectId: number,
  count = 1,
): Promise<number> {
  if (count < 1) throw new Error("allocateTicketNumbers: count must be at least 1");

  const rows = await executor.execute(sql`
    INSERT INTO project_ticket_counters (org_id, project_id, next_ticket_number)
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
