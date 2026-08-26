/**
 * The half a pure test cannot reach.
 *
 * Both reads over `activities` are cursor-paginated, and a cursor is the one
 * thing a mocked database cannot check: page one carries no cursor, so the
 * branch that uses it never runs until a second page is asked for. The timeline
 * shipped with a keyset that threw on every page two — valid SQL, green unit
 * tests, a bare `Date` the driver could not serialise — and it took a real
 * connection to see it. `due_at is null` as a sort key and a keyset that has to
 * step across the null group are the same kind of claim.
 *
 * Guarded by CRM_DB_TESTS=1 so the default hermetic `jest` run is unaffected and
 * CI without a database does not fail. Run with:
 *   CRM_DB_TESTS=1 npx jest --runInBand --testPathPattern="activity-cursors.db"
 *
 * Everything happens inside a transaction that is rolled back, fixtures
 * included, so the tests leave the database exactly as they found it.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { MyTasksService } from "./my-tasks.service";
import { ActivitiesService } from "./activities.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { Db } from "../../db/drizzle.types";
import type { TaskPage } from "./task-list";

const ENABLED = process.env.CRM_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

if (ENABLED) jest.setTimeout(120_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for CRM_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

/**
 * Four tasks that between them cover every branch of the ordering.
 *
 * One overdue, one due today, one due later, one with no date at all — and the
 * undated one deliberately anchored to a deal id that is not a number, because
 * `dealId` on the create schema is a free string and coercing it in SQL is what
 * this read refuses to do.
 */
const FIXTURES: Array<{ id: string; dueAt: string | null; anchored: boolean; subject: string }> = [
  { id: "overdue", dueAt: "2026-08-01T09:00:00Z", anchored: true, subject: "Chase the signed order" },
  { id: "today", dueAt: "2026-08-26T09:00:00Z", anchored: true, subject: "Call back about pricing" },
  { id: "later", dueAt: "2026-09-30T09:00:00Z", anchored: false, subject: "Renewal review" },
  { id: "undated", dueAt: null, anchored: false, subject: "Someday: tidy the notes" },
];

const IN_DUE_ORDER = [
  "Chase the signed order",
  "Call back about pricing",
  "Renewal review",
  "Someday: tidy the notes",
];

describeDb("activity cursors — real database", () => {
  let client: ReturnType<typeof postgres>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client) as unknown as Db;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /** Plants the fixtures, hands the service to the body and rolls it all back. */
  async function withTasks<T>(
    body: (fixture: {
      tasks: MyTasksService;
      timeline: ActivitiesService;
      orgId: string;
      userId: string;
      partyId: string;
    }) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '60s'"));

        const org = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
        const orgId = org[0]?.id;
        if (!orgId) throw new Error("CRM_DB_TESTS needs at least one organization to scope fixtures to");
        const userId = `mt-${randomUUID()}`;
        const partyId = randomUUID();

        await tx.execute(sql`
          INSERT INTO business_parties ("party_id", "organization_id", "name")
          VALUES (${partyId}, ${orgId}, 'Northwind Traders')
        `);

        for (const fixture of FIXTURES) {
          await tx.execute(sql`
            INSERT INTO activities
              ("activity_id", "organization_id", "kind", "occurred_at", "subject",
               "party_id", "deal_id", "actor_kind", "actor_user_id", "due_at", "assignee_user_id")
            VALUES (
              ${`${userId}-${fixture.id}`}, ${orgId}, 'task',
              ${"2026-08-20T09:00:00Z"}::timestamp, ${fixture.subject},
              ${fixture.anchored ? partyId : null},
              ${fixture.anchored ? null : "not-a-number"},
              'human', ${userId},
              ${fixture.dueAt}::timestamp, ${userId}
            )
          `);
        }

        const db = tx as unknown as Db;
        captured = await body({
          tasks: new MyTasksService(db),
          timeline: new ActivitiesService(db, {} as AuditService),
          orgId,
          userId,
          partyId,
        });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  const read = (tasks: MyTasksService, orgId: string, userId: string): Promise<TaskPage> =>
    tasks.myTasks(orgId, userId, { includeCompleted: false, limit: 25 });

  it("puts the soonest first and the undated last", async () => {
    const subjects = await withTasks(async ({ tasks, orgId, userId }) => {
      const page = await read(tasks, orgId, userId);
      return page.data.map((entry) => entry.subject);
    });

    expect(subjects).toEqual(IN_DUE_ORDER);
  });

  it("names what each task is about", async () => {
    const result = await withTasks(async ({ tasks, orgId, userId, partyId }) => {
      const page = await read(tasks, orgId, userId);
      return { anchor: page.data[0]?.anchor, partyId };
    });

    expect(result.anchor).toEqual({
      kind: "party",
      id: result.partyId,
      name: "Northwind Traders",
    });
  });

  /** A deal anchor that is not a number is data, not a crash. */
  it("renders a task whose deal id is not a deal id", async () => {
    const anchor = await withTasks(async ({ tasks, orgId, userId }) => {
      const page = await read(tasks, orgId, userId);
      return page.data.find((entry) => entry.subject?.startsWith("Someday"))?.anchor;
    });

    expect(anchor).toEqual({ kind: "deal", id: "not-a-number", name: null });
  });

  /**
   * The step a single row comparison gets wrong.
   *
   * Page two has to cross from the dated rows into the null group; written as
   * one `(due_at, activity_id) > (?, ?)` it is unknown for every undated row and
   * they all disappear off the end of the list.
   */
  it("walks every page without losing the undated tasks", async () => {
    const seen = await withTasks(async ({ tasks, orgId, userId }) => {
      const subjects: string[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 10; page += 1) {
        const result = await tasks.myTasks(orgId, userId, {
          includeCompleted: false,
          limit: 1,
          cursor,
        });
        subjects.push(...result.data.map((entry) => entry.subject ?? ""));
        if (!result.pagination.nextCursor) break;
        cursor = result.pagination.nextCursor;
      }

      return subjects;
    });

    expect(seen).toEqual(IN_DUE_ORDER);
  });

  /**
   * The defect that shipped.
   *
   * `sql\`(occurred_at, activity_id) < (${new Date(iso)}, ${id})\`` hands
   * postgres-js a `Date` with no type attached, and it throws trying to
   * serialise it as text. Nine lists carried that line. This asks for the second
   * page, which is the only request that runs it.
   */
  it("walks the timeline past page one", async () => {
    const subjects = await withTasks(async ({ timeline, orgId, partyId }) => {
      const first = await timeline.timeline(orgId, { partyId, limit: 1 });
      const cursor = first.pagination.nextCursor;
      if (!cursor) throw new Error("fixture should have produced more than one page");

      const second = await timeline.timeline(orgId, { partyId, limit: 1, cursor });
      return [...first.data, ...second.data].map((entry) => entry.subject);
    });

    expect(subjects).toEqual(["Call back about pricing", "Chase the signed order"]);
  });

  it("shows one tenant nothing of another's", async () => {
    const rows = await withTasks(async ({ tasks, userId }) => {
      const page = await tasks.myTasks(randomUUID(), userId, {
        includeCompleted: false,
        limit: 25,
      });
      return page.data;
    });

    expect(rows).toEqual([]);
  });
});
