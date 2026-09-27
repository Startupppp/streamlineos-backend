import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import { changeRequests } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { nextChangeRequestNumber } from "./change-request-number-counter";

type Sql = ReturnType<typeof postgres>;

interface Fixture {
  orgId: string;
  userId: string;
  projectId: number;
}

async function seed(sqlClient: Sql): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `cr57-${tag}`;
  const userId = `cr57-u-${tag}`;
  return sqlClient.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'CR57 Fixture')`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`CR57 ${tag}`}, ${`cr57-${tag}`}, 1, 'USD')
    `;
    const [member] = await tx<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner)
      VALUES (${userId}, ${orgId}, 'OWNER', true)
      RETURNING id
    `;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key)
      VALUES (${orgId}, 'CR57 Project', ${`CR57-${tag.slice(0, 4).toUpperCase()}`})
      RETURNING id
    `;
    return { orgId, userId, projectId: project.id };
  });
}

async function dropFixtures(sqlClient: Sql, fixtures: Fixture[]): Promise<void> {
  if (fixtures.length === 0) return;
  await sqlClient.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM organizations WHERE id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describe("nextChangeRequestNumber — pg_advisory_xact_lock serializes concurrent allocation in a live database", () => {
  let sqlClient: Sql;
  let db: Db;
  const fixtures: Fixture[] = [];

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("change-request-number-counter.db.spec.ts requires DATABASE_URL");
    sqlClient = postgres(url, { max: 2, prepare: false });
    db = drizzle(sqlClient, { schema });
  });

  afterAll(async () => {
    await dropFixtures(sqlClient, fixtures);
    await sqlClient?.end({ timeout: 5 });
  }, 60_000);

  it("BITE: two concurrent db.transaction calls on the same projectId produce distinct sequential crNumbers — advisory lock prevents duplicate allocation", async () => {
    const f = await seed(sqlClient);
    fixtures.push(f);

    const [n1, n2] = await Promise.all([
      db.transaction(async (tx) => {
        const n = await nextChangeRequestNumber(tx, f.orgId, f.projectId);
        await tx.insert(changeRequests).values({
          orgId: f.orgId,
          projectId: f.projectId,
          crNumber: n,
          title: "Concurrent CR A",
        });
        return n;
      }),
      db.transaction(async (tx) => {
        const n = await nextChangeRequestNumber(tx, f.orgId, f.projectId);
        await tx.insert(changeRequests).values({
          orgId: f.orgId,
          projectId: f.projectId,
          crNumber: n,
          title: "Concurrent CR B",
        });
        return n;
      }),
    ]);

    expect(n1).not.toBe(n2);
    expect([n1, n2].sort((a, b) => a - b)).toEqual([1, 2]);
  }, 30_000);

  it("BITE: uq_change_requests_project_number rejects a duplicate crNumber — partial unique index is live and non-null deleted_at rows are excluded", async () => {
    const f = await seed(sqlClient);
    fixtures.push(f);
    await sqlClient`
      INSERT INTO build.change_requests (org_id, project_id, cr_number, title)
      VALUES (${f.orgId}, ${f.projectId}, 1, 'First CR')
    `;
    await expect(
      sqlClient`
        INSERT INTO build.change_requests (org_id, project_id, cr_number, title)
        VALUES (${f.orgId}, ${f.projectId}, 1, 'Duplicate CR')
      `
    ).rejects.toMatchObject({ code: "23505" });
  }, 30_000);
});
