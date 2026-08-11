import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const adminUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("DATABASE_URL is required (owner role, to bypass RLS during load).");
  process.exit(1);
}

const KEY_PREFIX = "SD";
const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const num = (name, fallback) => Number(process.env[name] ?? fallback);

const BIG_ORG = process.env.SEED_ORG_ID || "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const NEIGHBOUR_ORG = process.env.SEED_NEIGHBOUR_ORG_ID || "762942e0-8c2f-45fd-b57a-da971f4b465b";
const PROJECTS = num("SEED_PROJECTS", 60);
const TICKETS = num("SEED_TICKETS", 200000);
const COMMENTS = num("SEED_COMMENTS", 500000);
const ACTIVITY = num("SEED_ACTIVITY", 400000);
const RELATIONS = num("SEED_RELATIONS", 60000);
const TIMESHEETS = num("SEED_TIMESHEETS", 150000);
const NEIGHBOUR_PROJECTS = num("SEED_NEIGHBOUR_PROJECTS", 4);
const NEIGHBOUR_TICKETS = num("SEED_NEIGHBOUR_TICKETS", 4000);
const CHUNK = num("SEED_CHUNK", 25000);
const SPRINTS_PER_PROJECT = 5;
const LABELS_PER_PROJECT = 8;

const sql = postgres(adminUrl, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

async function chunked(total, label, run) {
  for (let offset = 0; offset < total; offset += CHUNK) {
    const size = Math.min(CHUNK, total - offset);
    await run(offset, size);
    log(`${label}: ${offset + size}/${total}`);
  }
}

async function resolveUsers(orgId) {
  const rows = await sql`
    select user_id from organization_members
    where org_id = ${orgId} and status = 'ACTIVE' order by user_id`;
  if (!rows.length) throw new Error(`org ${orgId} has no ACTIVE members to attribute seed rows to`);
  return rows.map((r) => r.user_id);
}

async function reset(orgId) {
  await sql`delete from projects where org_id = ${orgId} and key like ${KEY_PREFIX + "%"}`;
  await sql`delete from pm_workspaces where org_id = ${orgId} and slug = 'seed-load'`;
  log(`reset: cleared seeded projects for ${orgId}`);
}

async function ensureWorkspace(orgId) {
  const id = `ws-seed-${orgId.slice(0, 8)}`;
  await sql`
    insert into pm_workspaces (pm_workspace_id, org_id, name, slug, is_default)
    values (${id}, ${orgId}, 'Seed Load Workspace', 'seed-load', false)
    on conflict do nothing`;
  return id;
}

async function seedProjects(orgId, workspaceId, count, users) {
  await sql`
    insert into projects (org_id, pm_workspace_id, name, key, status, created_at, updated_at)
    select ${orgId}, ${workspaceId},
           'Seed Project ' || g,
           ${KEY_PREFIX} || g,
           (array['ACTIVE','ACTIVE','ACTIVE','COMPLETED','ARCHIVED'])[1 + (g % 5)]::project_status,
           now() - ((g % 400) || ' days')::interval,
           now() - ((g % 90) || ' days')::interval
    from generate_series(1, ${count}::int) g`;

  const projects = await sql`
    select id from projects where org_id = ${orgId} and key like ${KEY_PREFIX + "%"} order by id`;
  const ids = projects.map((p) => p.id);
  log(`projects: ${ids.length}`);

  await sql`
    insert into project_statuses (org_id, project_id, name, "order", type, created_at)
    select ${orgId}, p.id, s.name, s.ord, s.typ, now()
    from unnest(${sql.array(ids)}::int[]) p(id)
    cross join (values
      ('TODO',0,'unstarted'),('IN_PROGRESS',1,'started'),
      ('IN_REVIEW',2,'started'),('DONE',3,'completed')) s(name, ord, typ)`;

  await sql`
    insert into sprints (org_id, project_id, name, start_date, end_date)
    select ${orgId}, p.id, 'Sprint ' || s.n,
           now() - ((s.n * 14) || ' days')::interval,
           now() - (((s.n - 1) * 14) || ' days')::interval
    from unnest(${sql.array(ids)}::int[]) p(id)
    cross join generate_series(1, ${SPRINTS_PER_PROJECT}::int) s(n)`;

  await sql`
    insert into project_members (project_id, user_id, org_id)
    select p.id, u.uid, ${orgId}
    from unnest(${sql.array(ids)}::int[]) p(id)
    cross join unnest(${sql.array(users)}::text[]) u(uid)
    on conflict do nothing`;

  await sql`
    insert into ticket_labels (org_id, name, color, created_at)
    select ${orgId}, 'seed-label-' || g, '#3B82F6', now()
    from generate_series(1, ${LABELS_PER_PROJECT}::int) g
    on conflict do nothing`;

  return ids;
}

async function seedTickets(orgId, projectIds, total, users) {
  const perProject = Math.ceil(total / projectIds.length);
  await chunked(total, "tickets", async (offset, size) => {
    await sql`
      insert into tickets (
        org_id, project_id, title, description, ticket_number, type, status, priority,
        assignee_id, reporter_id, points, rank, start_date, due_date,
        completion_percentage, created_at, updated_at)
      select ${orgId},
             p.id,
             'Seed ticket ' || g || ' for project ' || p.id,
             case when g % 4 = 0 then null else repeat('Body text for seeded work item. ', 8) end,
             ((g - 1) / ${projectIds.length}) + 1,
             (array['EPIC','STORY','TASK','TASK','TASK','BUG'])[1 + (g % 6)]::ticket_type,
             (array['TODO','IN_PROGRESS','IN_REVIEW','DONE'])[1 + (g % 4)],
             (array['LOW','MEDIUM','HIGH','URGENT'])[1 + (g % 4)]::ticket_priority,
             case when g % 7 = 0 then null else u.uid end,
             u2.uid,
             case when g % 3 = 0 then null else (g % 13) end,
             ((((g - 1) / ${projectIds.length}) + 1) * 1000)::numeric,
             (now() - ((g % 300) || ' days')::interval)::date,
             (now() + ((g % 60) || ' days')::interval)::date,
             (g % 101),
             now() - ((g % 730) || ' days')::interval,
             now() - ((g % 120) || ' days')::interval
      from generate_series(${offset + 1}::int, ${offset + size}::int) g
      join lateral (
        select id from unnest(${sql.array(projectIds)}::int[]) with ordinality t(id, rn)
        where t.rn = ((g - 1) % ${projectIds.length}) + 1
      ) p on true
      join lateral (
        select uid from unnest(${sql.array(users)}::text[]) with ordinality x(uid, rn)
        where x.rn = (g % ${users.length}) + 1
      ) u on true
      join lateral (
        select uid from unnest(${sql.array(users)}::text[]) with ordinality y(uid, rn)
        where y.rn = ((g + 1) % ${users.length}) + 1
      ) u2 on true`;
  });

  const [range] = await sql`
    select min(id)::int lo, max(id)::int hi, count(*)::int n
    from tickets where org_id = ${orgId}`;
  log(`tickets: id range ${range.lo}..${range.hi} (perProject≈${perProject})`);
  return range;
}

async function seedTicketChildren(orgId, range, users, projectCount) {
  const span = range.hi - range.lo + 1;

  await sql`
    insert into ticket_assignees (org_id, ticket_id, user_id, assigned_at)
    select ${orgId}, t.id, t.assignee_id, t.created_at
    from tickets t where t.org_id = ${orgId} and t.assignee_id is not null
    on conflict do nothing`;
  log("ticket_assignees: done");

  const labels = await sql`
    select id from ticket_labels where org_id = ${orgId} order by id limit ${LABELS_PER_PROJECT}`;
  if (labels.length) {
    await sql`
      insert into ticket_label_mappings (org_id, ticket_id, label_id, created_at)
      select ${orgId}, t.id, l.id, t.created_at
      from tickets t
      join lateral (
        select id from unnest(${sql.array(labels.map((l) => l.id))}::int[]) with ordinality z(id, rn)
        where z.rn = (t.id % ${labels.length}) + 1
      ) l on true
      where t.org_id = ${orgId} and t.id % 2 = 0
      on conflict do nothing`;
    log("ticket_label_mappings: done");
  }

  await chunked(COMMENTS, "ticket_comments", async (offset, size) => {
    await sql`
      insert into ticket_comments (org_id, ticket_id, user_id, content, created_at, updated_at)
      select ${orgId},
             ${range.lo} + (g % ${span}),
             u.uid,
             'Seeded discussion comment number ' || g || ' with enough text to be realistic.',
             now() - ((g % 500) || ' days')::interval,
             now() - ((g % 200) || ' days')::interval
      from generate_series(${offset + 1}::int, ${offset + size}::int) g
      join lateral (
        select uid from unnest(${sql.array(users)}::text[]) with ordinality x(uid, rn)
        where x.rn = (g % ${users.length}) + 1
      ) u on true`;
  });

  await chunked(ACTIVITY, "ticket_activity_log", async (offset, size) => {
    await sql`
      insert into ticket_activity_log (org_id, ticket_id, user_id, action, from_value, to_value, created_at)
      select ${orgId},
             ${range.lo} + (g % ${span}),
             u.uid,
             (array['created','status_changed','priority_changed','assignee_changed','comment_added'])[1 + (g % 5)]::ticket_activity_action,
             'TODO', 'IN_PROGRESS',
             now() - ((g % 600) || ' days')::interval
      from generate_series(${offset + 1}::int, ${offset + size}::int) g
      join lateral (
        select uid from unnest(${sql.array(users)}::text[]) with ordinality x(uid, rn)
        where x.rn = (g % ${users.length}) + 1
      ) u on true`;
  });

  await sql`
    insert into work_item_relations (org_id, work_item_id, related_work_item_id, relation_type, created_at)
    select ${orgId}, a.id, b.id,
           (array['blocks','blocked_by','duplicate_of','relates_to'])[1 + (a.id % 4)]::work_item_relation_type,
           a.created_at
    from tickets a
    join tickets b on b.id = a.id + ${projectCount} and b.project_id = a.project_id
    where a.org_id = ${orgId} and a.id % 3 = 0
    limit ${RELATIONS}::int
    on conflict do nothing`;
  log("work_item_relations: done");
}

async function seedTimesheets(orgId, range, users) {
  const span = range.hi - range.lo + 1;
  await chunked(TIMESHEETS, "timesheets", async (offset, size) => {
    await sql`
      insert into timesheets (
        org_id, user_id, ticket_id, project_id, date, hours, description,
        status, is_billable, bill_rate, currency, created_at, updated_at)
      select ${orgId},
             u.uid,
             t.id,
             t.project_id,
             (now() - ((g % 400) || ' days')::interval)::date,
             ((g % 8) + 1)::numeric,
             'Seeded work log ' || g,
             (array['PENDING','APPROVED','APPROVED','APPROVED'])[1 + (g % 4)],
             (g % 3 <> 0),
             (75 + (g % 50))::numeric,
             'USD',
             now() - ((g % 400) || ' days')::interval,
             now() - ((g % 100) || ' days')::interval
      from generate_series(${offset + 1}::int, ${offset + size}::int) g
      join tickets t on t.id = ${range.lo} + (g % ${span})
      join lateral (
        select uid from unnest(${sql.array(users)}::text[]) with ordinality x(uid, rn)
        where x.rn = (g % ${users.length}) + 1
      ) u on true`;
  });
}

async function analyze() {
  const tables = [
    "projects", "tickets", "ticket_comments", "ticket_activity_log", "ticket_assignees",
    "ticket_label_mappings", "ticket_labels", "work_item_relations", "sprints",
    "project_members", "project_statuses", "timesheets", "pm_workspaces",
  ];
  for (const t of tables) await sql.unsafe(`analyze public.${t}`);
  log(`analyze: ${tables.length} tables`);
}

async function main() {
  await sql`set statement_timeout = 0`;

  if (RESET) {
    await reset(BIG_ORG);
    await reset(NEIGHBOUR_ORG);
  }

  const bigUsers = await resolveUsers(BIG_ORG);
  log(`big org ${BIG_ORG}: ${bigUsers.length} active members`);
  const bigWs = await ensureWorkspace(BIG_ORG);
  const bigProjects = await seedProjects(BIG_ORG, bigWs, PROJECTS, bigUsers);
  const bigRange = await seedTickets(BIG_ORG, bigProjects, TICKETS, bigUsers);
  await seedTicketChildren(BIG_ORG, bigRange, bigUsers, bigProjects.length);
  await seedTimesheets(BIG_ORG, bigRange, bigUsers);

  const nUsers = await resolveUsers(NEIGHBOUR_ORG);
  const nWs = await ensureWorkspace(NEIGHBOUR_ORG);
  const nProjects = await seedProjects(NEIGHBOUR_ORG, nWs, NEIGHBOUR_PROJECTS, nUsers);
  await seedTickets(NEIGHBOUR_ORG, nProjects, NEIGHBOUR_TICKETS, nUsers);
  log(`neighbour org ${NEIGHBOUR_ORG}: seeded for cross-tenant isolation probes`);

  await analyze();

  const counts = await sql`
    select relname, n_live_tup::int rows, pg_size_pretty(pg_total_relation_size(relid)) size
    from pg_stat_user_tables
    where schemaname = 'public' and n_live_tup > 0
    order by n_live_tup desc limit 15`;
  console.table(counts.map((r) => ({ table: r.relname, rows: r.rows, size: r.size })));
}

main()
  .then(() => log("seed complete"))
  .catch((err) => {
    console.error("SEED FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
