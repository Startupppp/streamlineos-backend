import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("APP_DATABASE_URL is required (the non-BYPASSRLS app role).");
  process.exit(1);
}

const ORG = process.env.SEED_ORG_ID || "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const OUT_DIR = resolve(process.cwd(), "../docs/refactor/baseline");
const sql = postgres(url, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });

const QUERIES = [
  {
    id: "Q1-board-page1",
    label: "Board / list, page 1, sorted by fractional rank (the benchmark)",
    text: `select t.id, t.title, t.description, t.status, t.priority, t.type, t.rank,
                  t.assignee_id, t.ticket_number, t.points, t.due_date, t.created_at
           from tickets t
           where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null
           order by t.rank asc, t.created_at desc, t.id asc
           limit 50 offset 0`,
  },
  {
    id: "Q2-board-deep-page",
    label: "Same list at offset 3000 (offset pagination cost)",
    text: `select t.id, t.title, t.description, t.status, t.priority, t.rank, t.created_at
           from tickets t
           where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null
           order by t.rank asc, t.created_at desc, t.id asc
           limit 50 offset 3000`,
  },
  {
    id: "Q3-list-count",
    label: "The COUNT(*) fired alongside every list request",
    text: `select count(*) from tickets t where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null`,
  },
  {
    id: "Q4-search-ilike",
    label: "Search: leading-wildcard ILIKE on title",
    text: `select t.id, t.title from tickets t
           where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null and t.title ILIKE '%ticket 1234%'
           order by t.rank asc limit 50`,
  },
  {
    id: "Q5-board-with-relations",
    label: "Board page 1 hydrated with assignees + labels (the relational `with` shape)",
    text: `select t.id, t.title, t.status, t.rank,
                  (select json_agg(json_build_object('id', u.id, 'name', u.name))
                     from ticket_assignees ta join users u on u.id = ta.user_id
                    where ta.ticket_id = t.id) assignees,
                  (select json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
                     from ticket_label_mappings tlm join ticket_labels l on l.id = tlm.label_id
                    where tlm.ticket_id = t.id) labels
           from tickets t
           where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null
           order by t.rank asc, t.created_at desc, t.id asc
           limit 50`,
  },
  {
    id: "Q6-my-work",
    label: "My Work: assigned tickets across the whole org",
    text: `select t.id, t.title, t.status, t.priority, t.due_date, t.project_id
           from tickets t
           where t.org_id = $1 and t.assignee_id = $3 and t.deleted_at is null and t.status <> 'DONE'
           order by t.due_date asc nulls last limit 50`,
  },
  {
    id: "Q7-status-counts",
    label: "Per-column badge counts for the board",
    text: `select t.status, count(*) from tickets t
           where t.org_id = $1 and t.project_id = $2 group by t.status`,
  },
  {
    id: "Q8-ticket-comments",
    label: "Ticket detail: comment thread",
    text: `select c.id, c.content, c.user_id, c.created_at
           from ticket_comments c
           where c.org_id = $1 and c.ticket_id = $4
           order by c.created_at desc limit 50`,
  },
  {
    id: "Q9-ticket-activity",
    label: "Ticket detail: activity feed",
    text: `select a.id, a.action, a.from_value, a.to_value, a.created_at
           from ticket_activity_log a
           where a.org_id = $1 and a.ticket_id = $4
           order by a.created_at desc limit 50`,
  },
  {
    id: "Q10-dependency-graph",
    label: "Dependency edges for a ticket (blocks / blocked_by)",
    text: `select r.id, r.relation_type, r.work_item_id, r.related_work_item_id
           from work_item_relations r
           where r.org_id = $1 and (r.work_item_id = $4 or r.related_work_item_id = $4)`,
  },
  {
    id: "Q11-portfolio-rollup",
    label: "Portfolio dashboard: per-project open/done rollup from daily snapshots (post-fix)",
    text: `select s.project_id::int,
                  coalesce(sum(case when s.state_group in ('backlog','unstarted','started') then s.count else 0 end),0)::int open_count,
                  coalesce(sum(case when s.state_group = 'completed' then s.count else 0 end),0)::int done_count
           from project_daily_snapshots s
           where s.org_id = $1
             and s.snapshot_date = (
               select max(s2.snapshot_date) from project_daily_snapshots s2 where s2.project_id = s.project_id
             )
           group by s.project_id
           order by open_count desc limit 50`,
  },
  {
    id: "Q12-timesheet-billing-rollup",
    label: "Billing: approved billable hours + amount by project",
    text: `select ts.project_id, sum(ts.hours) hours, sum(ts.hours * coalesce(ts.bill_rate,0)) amount
           from timesheets ts
           where ts.org_id = $1 and ts.status = 'APPROVED' and ts.is_billable = true
           group by ts.project_id order by amount desc limit 50`,
  },
];

async function pickFixtures() {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG}, true)`;
    const [p] = await tx`
      select id from projects where org_id = ${ORG} and key like 'SD%' order by id limit 1`;
    const [t] = await tx`
      select id from tickets where org_id = ${ORG} and project_id = ${p.id} order by id limit 1`;
    const [u] = await tx`
      select user_id from organization_members where org_id = ${ORG} and status = 'ACTIVE' limit 1`;
    return { projectId: p.id, ticketId: t.id, userId: u.user_id };
  });
}

function summarise(plan) {
  const root = plan.Plan;
  const shared = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
  const nodes = [];
  const walk = (n) => {
    nodes.push(n["Node Type"] + (n["Relation Name"] ? ` on ${n["Relation Name"]}` : "") + (n["Index Name"] ? ` using ${n["Index Name"]}` : ""));
    (n.Plans ?? []).forEach(walk);
  };
  walk(root);
  return {
    execMs: Number(plan["Execution Time"]?.toFixed(2)),
    planMs: Number(plan["Planning Time"]?.toFixed(2)),
    actualRows: root["Actual Rows"],
    blocks: shared,
    seqScans: nodes.filter((n) => n.startsWith("Seq Scan")).length,
    nodes,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const fixtures = await pickFixtures();
  console.log("fixtures:", fixtures);

  const results = [];
  for (const q of QUERIES) {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${ORG}, true)`;
      const all = [ORG, fixtures.projectId, fixtures.userId, fixtures.ticketId];
      const used = [...new Set(q.text.match(/\$\d/g) ?? [])];
      let text = q.text;
      used.forEach((token, i) => {
        text = text.split(token).join(`$${i + 1}`);
      });
      return tx.unsafe(
        `explain (analyze, buffers, format json) ${text}`,
        used.map((token) => all[Number(token.slice(1)) - 1]),
      );
    });
    const plan = rows[0]["QUERY PLAN"][0];
    const s = summarise(plan);
    results.push({ ...q, ...s, plan });
    console.log(
      `${q.id.padEnd(28)} ${String(s.execMs).padStart(9)}ms  rows=${String(s.actualRows).padStart(6)}  blocks=${String(s.blocks).padStart(7)}  seqScans=${s.seqScans}`,
    );
  }

  const sizes = await sql`
    select relname, n_live_tup::int rows,
           pg_size_pretty(pg_relation_size(relid)) heap,
           pg_size_pretty(pg_indexes_size(relid)) idx,
           pg_size_pretty(pg_total_relation_size(relid)) total
    from pg_stat_user_tables where schemaname='public' and n_live_tup > 100
    order by n_live_tup desc`;

  const idx = await sql`
    select relname, indexrelname, idx_scan::int scans, pg_size_pretty(pg_relation_size(indexrelid)) size
    from pg_stat_user_indexes
    where schemaname='public' and relname in
      ('tickets','ticket_comments','ticket_activity_log','ticket_assignees','ticket_label_mappings','timesheets','work_item_relations','projects')
    order by relname, scans`;

  writeFileSync(resolve(OUT_DIR, "baseline.json"), JSON.stringify({ org: ORG, fixtures, results, sizes, idx }, null, 2));

  const md = [
    "# Build module — Phase 0 performance baseline",
    "",
    `Captured as \`streamline_app\` (RLS enforced, \`app.organization_id\` set) against the seeded dataset.`,
    `Org \`${ORG}\` · project \`${fixtures.projectId}\` · ticket \`${fixtures.ticketId}\`.`,
    "",
    "## Query timings",
    "",
    "| ID | Query | Exec ms | Rows | Buffer blocks | Seq scans |",
    "|---|---|---:|---:|---:|---:|",
    ...results.map((r) => `| ${r.id} | ${r.label} | ${r.execMs} | ${r.actualRows} | ${r.blocks} | ${r.seqScans} |`),
    "",
    "## Table sizes",
    "",
    "| Table | Rows | Heap | Indexes | Total |",
    "|---|---:|---:|---:|---:|",
    ...sizes.map((s) => `| ${s.relname} | ${s.rows} | ${s.heap} | ${s.idx} | ${s.total} |`),
    "",
    "## Index scan counts (pre-traffic; zero means unproven, not unused)",
    "",
    "| Table | Index | Scans | Size |",
    "|---|---|---:|---:|",
    ...idx.map((i) => `| ${i.relname} | ${i.indexrelname} | ${i.scans} | ${i.size} |`),
    "",
    "## Plan nodes",
    "",
    ...results.flatMap((r) => [`### ${r.id} — ${r.label}`, "", "```", ...r.nodes.map((n) => "  " + n), "```", ""]),
  ].join("\n");

  writeFileSync(resolve(OUT_DIR, "baseline.md"), md);
  console.log(`\nwrote ${OUT_DIR}/baseline.{json,md}`);
}

main()
  .catch((e) => {
    console.error("BASELINE FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
