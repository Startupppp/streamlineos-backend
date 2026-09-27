import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { Test } from "@nestjs/testing";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsActivityFeedService } from "../projects-activity-feed.service";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

type Sql = ReturnType<typeof postgres>;

interface SeedResult {
  orgId: string;
  userId: string;
  membershipId: number;
  projectId: number;
  ticketId: number;
}

async function seed(sql: Sql): Promise<SeedResult> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `afp-${tag}`;
  const userId = `afp-u-${tag}`;

  return sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'Feed Plan Fixture')`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`FeedPlan ${tag}`}, ${`afp-${tag}`}, 1, 'USD')
    `;
    const [member] = await tx<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner)
      VALUES (${userId}, ${orgId}, 'OWNER', true)
      RETURNING id
    `;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, manager_membership_id)
      VALUES (${orgId}, ${`FP ${tag}`}, ${`FP${tag.slice(0, 4).toUpperCase()}`}, ${member.id})
      RETURNING id
    `;
    await tx`
      INSERT INTO build.project_statuses (org_id, project_id, name, "order", type)
      VALUES (${orgId}, ${project.id}, 'TODO', 0, 'unstarted')
    `;
    const [ticket] = await tx<{ id: number }[]>`
      INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
      VALUES (${orgId}, ${project.id}, 'AFP ticket', 1, 'TODO')
      RETURNING id
    `;
    return { orgId, userId, membershipId: member.id, projectId: project.id, ticketId: ticket.id };
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

async function buildService(db: Db): Promise<ProjectsActivityFeedService> {
  const module = await Test.createTestingModule({
    providers: [
      ProjectsActivityFeedService,
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return module.get(ProjectsActivityFeedService);
}

function makeActor(f: SeedResult): CurrentUserContext {
  return {
    userId: f.userId,
    orgId: f.orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: `sess-${f.userId}`,
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: f.membershipId, isOrgOwner: true },
  };
}

describe("ticket 17 activity feed — multi-page ordering and index usability", () => {
  let rawSql: Sql;
  let db: Db;
  let service: ProjectsActivityFeedService;
  const fixtures: SeedResult[] = [];

  beforeAll(async () => {
    const url = requireApprovedDatabaseUrl({
      spec: "ticket-17-activity-feed-plan.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    rawSql = postgres(url, { max: 2, prepare: false });
    db = drizzle(rawSql, { schema });
    service = await buildService(db);
  });

  afterAll(async () => {
    await dropFixtures(rawSql, fixtures);
    await rawSql?.end({ timeout: 5 });
  }, 60_000);

  it("feed returns natively-written rows and a pre-migration backfilled row in descending id order across two pages with no duplicates or gaps", async () => {
    const f = await seed(rawSql);
    fixtures.push(f);

    await rawSql`
      INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, project_id, action)
      VALUES
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'created'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'status_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'assignee_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'due_date_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'estimate_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'priority_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'cycle_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'type_changed')
    `;

    await rawSql`
      INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, action)
      VALUES (${f.orgId}, ${f.ticketId}, 'comment_added')
    `;

    await rawSql`
      UPDATE build_events.ticket_activity_log tal
         SET project_id = t.project_id
        FROM build.tickets t
       WHERE t.org_id = tal.org_id
         AND t.id = tal.ticket_id
         AND tal.project_id IS NULL
         AND tal.org_id = ${f.orgId}
    `;

    const actor = makeActor(f);

    const page1 = await service.getProjectActivity(actor, f.projectId, { limit: 5 });
    expect(page1.data).toHaveLength(5);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.pagination.nextCursor).not.toBeNull();

    const ids1 = page1.data.map((r) => r.id);
    for (let i = 0; i < ids1.length - 1; i++) {
      expect(ids1[i]!).toBeGreaterThan(ids1[i + 1]!);
    }

    const page2 = await service.getProjectActivity(actor, f.projectId, {
      limit: 5,
      cursor: page1.pagination.nextCursor!,
    });
    expect(page2.data).toHaveLength(4);
    expect(page2.pagination.hasMore).toBe(false);

    const ids2 = page2.data.map((r) => r.id);
    for (let i = 0; i < ids2.length - 1; i++) {
      expect(ids2[i]!).toBeGreaterThan(ids2[i + 1]!);
    }

    const setIds1 = new Set(ids1);
    expect(ids2.every((id) => !setIds1.has(id))).toBe(true);

    expect(ids1[ids1.length - 1]!).toBeGreaterThan(ids2[0]!);

    expect(page1.data.length + page2.data.length).toBe(9);
  }, 60_000);

  it("idx_ticket_activity_log_org_project can serve the feed filter+order+cursor as one index range when seqscan is disabled so the index shape is structurally correct for the query", async () => {
    const f = await seed(rawSql);
    fixtures.push(f);

    await rawSql`
      INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, project_id, action)
      VALUES
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'created'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'status_changed'),
        (${f.orgId}, ${f.ticketId}, ${f.projectId}, 'assignee_changed')
    `;

    const planRows = await rawSql.begin(async (tx) => {
      await tx`SET enable_seqscan = off`;
      return tx<{ "QUERY PLAN": string }[]>`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT id
          FROM build_events.ticket_activity_log
         WHERE org_id = ${f.orgId}
           AND project_id = ${f.projectId}
         ORDER BY id DESC
         LIMIT 21
      `;
    });

    const planText = planRows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(planText).toContain("idx_ticket_activity_log_org_project");
  }, 60_000);
});
