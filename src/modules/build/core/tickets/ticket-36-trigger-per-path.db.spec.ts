import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import type { Db } from "../../../../db/drizzle.types";

type Sql = ReturnType<typeof postgres>;

interface Fixture {
  orgId: string;
  userId: string;
  projectId: number;
  ticketId: number;
}

async function seedFixture(rawSql: Sql): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `t36-${tag}`;
  const userId = `t36-u-${tag}`;
  return rawSql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'T36 Fixture')`;
    await tx`INSERT INTO organizations (id, name, slug, owner_membership_id, currency) VALUES (${orgId}, ${`T36 ${tag}`}, ${orgId}, 1, 'USD')`;
    const [member] = await tx<{ id: number }[]>`INSERT INTO organization_members (user_id, org_id, role, is_owner, status) VALUES (${userId}, ${orgId}, 'OWNER', true, 'ACTIVE') RETURNING id`;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [proj] = await tx<{ id: number }[]>`INSERT INTO build.projects (org_id, name, key, manager_membership_id) VALUES (${orgId}, ${`T36 ${tag}`}, ${`TP${tag.slice(0, 4).toUpperCase()}`}, ${member.id}) RETURNING id`;
    await tx`INSERT INTO build.project_statuses (org_id, project_id, name, "order", type) VALUES (${orgId}, ${proj.id}, 'TODO', 0, 'unstarted'), (${orgId}, ${proj.id}, 'DONE', 1, 'completed')`;
    const [ticket] = await tx<{ id: number }[]>`INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status) VALUES (${orgId}, ${proj.id}, 'T36 ticket', 1, 'TODO') RETURNING id`;
    return { orgId, userId, projectId: proj.id, ticketId: ticket.id };
  });
}

async function insertTicket(rawSql: Sql, orgId: string, projectId: number, n: number): Promise<number> {
  const [row] = await rawSql<{ id: number }[]>`
    INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
    VALUES (${orgId}, ${projectId}, ${`Extra ${n}`}, ${n}, 'TODO') RETURNING id
  `;
  return row.id;
}

async function getVersion(rawSql: Sql, ticketId: number): Promise<number> {
  const [row] = await rawSql<{ version: number }[]>`
    SELECT version FROM build.tickets WHERE id = ${ticketId}
  `;
  return row.version;
}

async function dropFixtures(rawSql: Sql, fixtures: Array<{ orgId: string; userId: string }>): Promise<void> {
  if (fixtures.length === 0) return;
  await rawSql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM organizations WHERE id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describe("trg_tickets_version_bump (migration 1373) fires for every UPDATE path on build.tickets so the trigger's unconditional BEFORE UPDATE guarantee is confirmed live on this database", () => {
  let rawSql: Sql;
  let db: Db;
  const fixtures: Array<{ orgId: string; userId: string }> = [];

  async function fresh(): Promise<Fixture> {
    const f = await seedFixture(rawSql);
    fixtures.push({ orgId: f.orgId, userId: f.userId });
    return f;
  }

  beforeAll(() => {
    const url = requireApprovedDatabaseUrl({
      spec: "ticket-36-trigger-per-path.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    rawSql = postgres(url, { max: 2, prepare: false });
    db = drizzle(rawSql, { schema });
  });

  afterAll(async () => {
    await dropFixtures(rawSql, fixtures);
    await rawSql?.end({ timeout: 5 });
  }, 60_000);

  it("a raw-SQL UPDATE on build.tickets increments version by 1 so migration 1373 is confirmed applied to this database", async () => {
    const f = await fresh();
    const v0 = await getVersion(rawSql, f.ticketId);
    await rawSql`UPDATE build.tickets SET title = 'raw-path' WHERE id = ${f.ticketId} AND org_id = ${f.orgId}`;
    const v1 = await getVersion(rawSql, f.ticketId);
    expect(v1).toBe(v0 + 1);
  }, 30_000);

  it("two consecutive raw UPDATEs advance version by 2 total, confirming the trigger assigns OLD.version + 1 rather than adding to whatever the statement wrote", async () => {
    const f = await fresh();
    const v0 = await getVersion(rawSql, f.ticketId);
    await rawSql`UPDATE build.tickets SET title = 'step-1' WHERE id = ${f.ticketId} AND org_id = ${f.orgId}`;
    await rawSql`UPDATE build.tickets SET title = 'step-2' WHERE id = ${f.ticketId} AND org_id = ${f.orgId}`;
    const v2 = await getVersion(rawSql, f.ticketId);
    expect(v2).toBe(v0 + 2);
  }, 30_000);

  it("an UPDATE that also writes version = 99999 still ends at OLD.version + 1, confirming the trigger clobbers app-supplied values and no path can jump the token to an arbitrary number", async () => {
    const f = await fresh();
    const v0 = await getVersion(rawSql, f.ticketId);
    await rawSql`UPDATE build.tickets SET version = 99999, title = 'clobber-attempt' WHERE id = ${f.ticketId} AND org_id = ${f.orgId}`;
    const vAfter = await getVersion(rawSql, f.ticketId);
    expect(vAfter).toBe(v0 + 1);
  }, 30_000);

  it("the Drizzle ORM .update().set().where().returning() pattern used by apply-ticket-change and rankTicket returns the post-trigger version in the RETURNING clause so callers receive the token the trigger actually set", async () => {
    const f = await fresh();
    const v0 = await getVersion(rawSql, f.ticketId);
    const [row] = await db
      .update(schema.tickets)
      .set({ status: "DONE", updatedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.id, f.ticketId),
          eq(schema.tickets.orgId, f.orgId),
          isNull(schema.tickets.deletedAt),
        ),
      )
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    expect(row).toBeDefined();
    expect(row?.version).toBe(v0 + 1);
  }, 30_000);

  it("a multi-row Drizzle ORM UPDATE used by bulkMutateTickets increments each updated row's version individually so the batch path is covered by the trigger", async () => {
    const f = await fresh();
    const ticket2 = await insertTicket(rawSql, f.orgId, f.projectId, 2);
    const v1Before = await getVersion(rawSql, f.ticketId);
    const v2Before = await getVersion(rawSql, ticket2);
    const rows = await db
      .update(schema.tickets)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.orgId, f.orgId),
          inArray(schema.tickets.id, [f.ticketId, ticket2]),
          isNull(schema.tickets.deletedAt),
        ),
      )
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r.version]));
    expect(byId.get(f.ticketId)).toBe(v1Before + 1);
    expect(byId.get(ticket2)).toBe(v2Before + 1);
  }, 30_000);

  it("the raw-SQL CTE UPDATE used by rebalanceProjectRanks fires the trigger so rank rebalancing also bumps the version token", async () => {
    const f = await fresh();
    const v0 = await getVersion(rawSql, f.ticketId);
    await rawSql`
      WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY rank ASC, id ASC) * 1000 AS new_rank
        FROM build.tickets
        WHERE org_id = ${f.orgId} AND project_id = ${f.projectId} AND deleted_at IS NULL
      ) UPDATE build.tickets t SET rank = ordered.new_rank
        FROM ordered
        WHERE t.id = ordered.id AND t.org_id = ${f.orgId} AND t.project_id = ${f.projectId}
    `;
    const v1 = await getVersion(rawSql, f.ticketId);
    expect(v1).toBe(v0 + 1);
  }, 30_000);
});
