import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";

type Sql = ReturnType<typeof postgres>;

interface SeedResult {
  orgId: string;
  userId: string;
  projectId: number;
  ticketId: number;
}

async function seed(sql: Sql): Promise<SeedResult> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `bfr-${tag}`;
  const userId = `bfr-u-${tag}`;

  return sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'Backfill Fixture')`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`Backfill ${tag}`}, ${`bfr-${tag}`}, 1, 'USD')
    `;
    const [member] = await tx<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner)
      VALUES (${userId}, ${orgId}, 'OWNER', true)
      RETURNING id
    `;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, manager_membership_id)
      VALUES (${orgId}, ${`Proj ${tag}`}, ${`P${tag.slice(0, 4).toUpperCase()}`}, ${member.id})
      RETURNING id
    `;
    await tx`
      INSERT INTO build.project_statuses (org_id, project_id, name, "order", type)
      VALUES (${orgId}, ${project.id}, 'TODO', 0, 'unstarted')
    `;
    const [ticket] = await tx<{ id: number }[]>`
      INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
      VALUES (${orgId}, ${project.id}, 'BFR ticket', 1, 'TODO')
      RETURNING id
    `;
    return { orgId, userId, projectId: project.id, ticketId: ticket.id };
  });
}

async function dropFixtures(sql: Sql, fixtures: SeedResult[]): Promise<void> {
  if (fixtures.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM organizations WHERE id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describe("ticket 16 backfill reconciliation — migration 1378 backfill SQL sets project_id from build.tickets", () => {
  let sql: Sql;
  const fixtures: SeedResult[] = [];

  beforeAll(() => {
    const url = requireApprovedDatabaseUrl({
      spec: "ticket-16-backfill-reconciliation.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    sql = postgres(url, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await dropFixtures(sql, fixtures);
    await sql?.end({ timeout: 5 });
  }, 60_000);

  it("backfill UPDATE sets project_id from build.tickets on a row inserted without it so pre-migration rows are not lost from the project feed", async () => {
    const f = await seed(sql);
    fixtures.push(f);

    await sql`
      INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, action)
      VALUES (${f.orgId}, ${f.ticketId}, 'created')
    `;

    const [before] = await sql<{ project_id: number | null }[]>`
      SELECT project_id
        FROM build_events.ticket_activity_log
       WHERE org_id = ${f.orgId}
         AND ticket_id = ${f.ticketId}
       ORDER BY id DESC
       LIMIT 1
    `;
    expect(before.project_id).toBeNull();

    await sql`
      UPDATE build_events.ticket_activity_log tal
         SET project_id = t.project_id
        FROM build.tickets t
       WHERE t.org_id = tal.org_id
         AND t.id = tal.ticket_id
         AND tal.project_id IS NULL
         AND tal.org_id = ${f.orgId}
    `;

    const [after] = await sql<{ project_id: number | null }[]>`
      SELECT project_id
        FROM build_events.ticket_activity_log
       WHERE org_id = ${f.orgId}
         AND ticket_id = ${f.ticketId}
       ORDER BY id DESC
       LIMIT 1
    `;
    expect(after.project_id).toBe(f.projectId);
  }, 60_000);

  it("a row inserted WITH project_id already set is not changed by the backfill UPDATE so natively-written rows are unaffected", async () => {
    const f = await seed(sql);
    fixtures.push(f);

    await sql`
      INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, project_id, action)
      VALUES (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'status_changed')
    `;

    await sql`
      UPDATE build_events.ticket_activity_log tal
         SET project_id = t.project_id
        FROM build.tickets t
       WHERE t.org_id = tal.org_id
         AND t.id = tal.ticket_id
         AND tal.project_id IS NULL
         AND tal.org_id = ${f.orgId}
    `;

    const [row] = await sql<{ project_id: number | null; null_count: string }[]>`
      SELECT project_id,
             (SELECT COUNT(*) FROM build_events.ticket_activity_log
               WHERE org_id = ${f.orgId} AND project_id IS NULL)::text AS null_count
        FROM build_events.ticket_activity_log
       WHERE org_id = ${f.orgId}
         AND ticket_id = ${f.ticketId}
       ORDER BY id DESC
       LIMIT 1
    `;
    expect(row.project_id).toBe(f.projectId);
    expect(Number(row.null_count)).toBe(0);
  }, 60_000);
});
