import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("APP_DATABASE_URL is required (the non-BYPASSRLS app role).");
  process.exit(1);
}

const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const sql = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

const CHECKS = [
  {
    id: "scoped-board-page",
    ceiling: 5000,
    requireIndexOnlyOn: "ticket_assignees",
    params: (f) => [ORG, f.projectId, f.userId],
    text: `
      select t.id, count(*) over () total
      from build.tickets t
      where t.org_id = $1 and t.project_id = $2 and t.deleted_at is null
        and (t.assignee_id = $3 or t.reporter_id = $3
             or exists (select 1 from build.ticket_assignees ta
                        where ta.org_id = $1 and ta.user_id = $3 and ta.ticket_id = t.id))
      order by t.rank asc, t.created_at desc, t.id asc
      limit 50 offset 0`,
  },
  {
    id: "my-work",
    ceiling: 30000,
    requireIndexOnlyOn: "ticket_assignees",
    params: (f) => [ORG, f.userId],
    text: `
      select u.id, count(*) over () total from (
        (select t.id as id, t.due_date as due_date, t.priority as priority
         from build.tickets t inner join build.projects p on p.id = t.project_id
         where t.org_id = $1 and p.status <> 'ARCHIVED' and t.deleted_at is null and t.assignee_id = $2)
        union
        (select t.id as id, t.due_date as due_date, t.priority as priority
         from build.tickets t inner join build.projects p on p.id = t.project_id
         inner join build.ticket_assignees ta on ta.ticket_id = t.id and ta.org_id = $1 and ta.user_id = $2
         where t.org_id = $1 and p.status <> 'ARCHIVED' and t.deleted_at is null)
      ) u
      order by u.due_date asc nulls last,
        case u.priority when 'URGENT' then 1 when 'HIGH' then 2 when 'MEDIUM' then 3 when 'LOW' then 4 else 5 end asc,
        u.id asc
      limit 100 offset 0`,
  },
];

function walk(node, out) {
  out.push({
    type: node["Node Type"],
    relation: node["Relation Name"] ?? null,
    index: node["Index Name"] ?? null,
  });
  (node.Plans ?? []).forEach((child) => walk(child, out));
  return out;
}

async function main() {
  const fixtures = await sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG}, true)`;
    const [project] = await tx`
      select project_id, count(*)::int n from build.tickets
      where org_id = ${ORG} and deleted_at is null
      group by project_id order by n desc limit 1`;
    const [participant] = await tx`
      select user_id, count(*)::int n from build.ticket_assignees
      where org_id = ${ORG} group by user_id order by n desc limit 1`;
    return {
      projectId: project.project_id,
      projectTickets: project.n,
      userId: participant.user_id,
      participationOrgWide: participant.n,
    };
  });

  console.log(
    `project ${fixtures.projectId} (${fixtures.projectTickets} tickets) · participant holds ${fixtures.participationOrgWide} rows org-wide`,
  );

  const failures = [];
  for (const check of CHECKS) {
    const plan = await sql.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${ORG}, true)`;
      const rows = await tx.unsafe(
        `explain (analyze, buffers, format json) ${check.text}`,
        check.params(fixtures),
      );
      return rows[0]["QUERY PLAN"][0];
    });

    const root = plan.Plan;
    const blocks = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
    const node = walk(root, []).find((n) => n.relation === check.requireIndexOnlyOn);

    console.log(
      `${check.id.padEnd(20)} blocks=${String(blocks).padStart(7)} (ceiling ${check.ceiling})  ` +
        `${check.requireIndexOnlyOn}: ${node ? `${node.type} using ${node.index}` : "ABSENT"}`,
    );

    if (blocks > check.ceiling)
      failures.push(`${check.id}: ${blocks} > ${check.ceiling}`);
    if (!node)
      failures.push(`${check.id}: no ${check.requireIndexOnlyOn} node — the query shape changed`);
    else if (!node.type.startsWith("Index Only Scan"))
      failures.push(
        `${check.id}: ${check.requireIndexOnlyOn} resolved by ${node.type}, not Index Only Scan — the tenant-led covering index is missing or unusable`,
      );
  }

  if (failures.length > 0) {
    failures.forEach((f) => console.error("FAIL:", f));
    process.exitCode = 1;
    return;
  }
  console.log("OK");
}

main()
  .catch((e) => {
    console.error("CHECK FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
