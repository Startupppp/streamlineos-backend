import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("PREREQUISITE MISSING: APP_DATABASE_URL is required (the non-BYPASSRLS app role).");
  process.exit(2);
}

const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const sql = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

async function resolveFixtureOrg() {
  if (process.env.SEED_ORG_ID) return process.env.SEED_ORG_ID;
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) {
    console.error(
      "Set SEED_ORG_ID, or provide DATABASE_URL so the busiest org can be discovered.\n" +
        "Discovery has to compare row counts ACROSS orgs, which RLS forbids the app role\n" +
        "to do — so it runs as the owner. Every measurement below still runs as the app\n" +
        "role with the tenant GUC set, which is the only role whose plans mean anything.",
    );
    process.exit(2);
  }
  const owner = postgres(ownerUrl, { max: 1, prepare: false, ssl, onnotice: () => {} });
  try {
    const [busiest] = await owner`
      select org_id, count(*)::int n from build.tickets
      where deleted_at is null group by org_id order by n desc limit 1`;
    if (!busiest) {
      console.error(
        "No org has any build.tickets rows, so there is nothing to measure.\n" +
          "An empty table plans differently, so any number taken here would be meaningless.\n" +
          "Seed first: pnpm seed:build-load, or set SEED_ORG_ID to a populated org.",
      );
      process.exit(2);
    }
    console.log(`fixture org ${busiest.org_id} resolved by ticket volume (${busiest.n} tickets)`);
    return busiest.org_id;
  } finally {
    await owner.end();
  }
}

const ORG = await resolveFixtureOrg();

const UNREALISTIC_SHARE = 0.1;

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
    executed: (node["Actual Loops"] ?? 0) > 0,
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
    const [collaborator] = await tx`
      select ta.user_id, count(*)::int n from build.ticket_assignees ta
      join build.tickets t on t.id = ta.ticket_id and t.org_id = ta.org_id
      where ta.org_id = ${ORG}
        and t.assignee_id is distinct from ta.user_id
        and t.reporter_id is distinct from ta.user_id
      group by ta.user_id order by n desc limit 1`;
    const [participant] = collaborator
      ? [collaborator]
      : await tx`
          select user_id, count(*)::int n from build.ticket_assignees
          where org_id = ${ORG} group by user_id order by n desc limit 1`;
    if (!project || !participant) {
      const missing = [!project && "build.tickets", !participant && "build.ticket_assignees"]
        .filter(Boolean)
        .join(" and ");
      throw new Error(
        `org ${ORG} has no rows in ${missing}, so no fixture can be built.\n` +
          "Seed first: pnpm seed:build-load, or set SEED_ORG_ID to a populated org.",
      );
    }
    const [spread] = await tx`
      select count(*)::int total, count(distinct user_id)::int users
      from build.ticket_assignees where org_id = ${ORG}`;
    const [held] = await tx`
      select count(*)::int n from build.ticket_assignees
      where org_id = ${ORG} and user_id = ${participant.user_id}`;
    return {
      projectId: project.project_id,
      projectTickets: project.n,
      userId: participant.user_id,
      participationOrgWide: participant.n,
      participantShare: spread.total > 0 ? held.n / spread.total : 0,
      distinctParticipants: spread.users,
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

    const state = !node ? "ABSENT" : node.executed ? `${node.type} using ${node.index}` : `${node.type} (never executed)`;
    console.log(
      `${check.id.padEnd(20)} blocks=${String(blocks).padStart(7)} (ceiling ${check.ceiling})  ` +
        `${check.requireIndexOnlyOn}: ${state}`,
    );

    if (blocks > check.ceiling)
      failures.push(`${check.id}: ${blocks} > ${check.ceiling}`);
    if (!node)
      failures.push(`${check.id}: no ${check.requireIndexOnlyOn} node — the query shape changed`);
    else if (!node.executed)
      failures.push(
        `${check.id}: the ${check.requireIndexOnlyOn} branch was planned but NEVER EXECUTED, so its access path is unproven. ` +
          `The fixture participant reaches every row through tickets.assignee_id/reporter_id, so the OR short-circuits before the semi-join. ` +
          `Seed a participant who appears ONLY in ${check.requireIndexOnlyOn} (pnpm seed:build-load creates one) or this assertion is vacuous.`,
      );
    else if (!node.type.startsWith("Index Only Scan"))
      failures.push(
        fixtures.participantShare > UNREALISTIC_SHARE
          ? `${check.id}: ${check.requireIndexOnlyOn} resolved by ${node.type}, but that is the CORRECT plan here and the index is not at fault — ` +
            `the fixture participant holds ${(fixtures.participantShare * 100).toFixed(0)}% of the table ` +
            `across only ${fixtures.distinctParticipants} distinct participant(s), and no index beats a sequential scan at that selectivity. ` +
            `Seed a production-shaped member distribution before reading this as an index defect.`
          : `${check.id}: ${check.requireIndexOnlyOn} resolved by ${node.type}, not Index Only Scan — the tenant-led covering index is missing or unusable`,
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
