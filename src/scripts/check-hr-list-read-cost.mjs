import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("PREREQUISITE MISSING: APP_DATABASE_URL is required (the non-BYPASSRLS app role).");
  process.exit(2);
}

const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const sql = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

const REVIEW_COLUMNS = `
  pr.id, pr.org_id, pr.user_id, pr.reviewer_id, pr.cycle_id, pr.period_start,
  pr.period_end, pr.status, pr.overall_rating, pr.created_at, pr.updated_at,
  u.id, u.name, u.image, rv.id, rv.name, c.id, c.name, c.status`;

const REVIEW_JOINS = `
  from performance_reviews pr
  left join users u on u.id = pr.user_id
  left join users rv on rv.id = pr.reviewer_id
  left join review_cycles c on c.id = pr.cycle_id and c.org_id = pr.org_id`;


const TICKET_COLUMNS = `
  t.id, t.org_id, t.user_id, t.title, t.description, t.category, t.priority, t.status,
  t.assignee_id, t.is_confidential, t.sla_due_at, t.resolved_at, t.resolution,
  t.created_at, t.updated_at, u.name, u.image`;

const TICKET_JOINS = `
  from helpdesk_tickets t
  left join users u on u.id = t.user_id`;

const HELPDESK_CHECKS = [
  {
    id: "helpdesk-page-1",
    ceiling: 2000,
    requireIndexOn: "helpdesk_tickets",
    params: () => [ORG],
    text: `select ${TICKET_COLUMNS} ${TICKET_JOINS}
           where t.org_id = $1
           order by t.created_at desc, t.id desc limit 21`,
  },
  {
    id: "helpdesk-page-deep-cursor",
    ceiling: 2000,
    requireIndexOn: "helpdesk_tickets",
    params: (f) => [ORG, f.ticketCreatedAt, f.ticketId],
    text: `select ${TICKET_COLUMNS} ${TICKET_JOINS}
           where t.org_id = $1 and (t.created_at, t.id) < ($2, $3)
           order by t.created_at desc, t.id desc limit 21`,
  },
  {
    id: "helpdesk-non-admin-cursor",
    ceiling: 2000,
    requireIndexOn: "helpdesk_tickets",
    params: (f) => [ORG, f.ticketOwnerId, f.ticketCreatedAt, f.ticketId],
    text: `select ${TICKET_COLUMNS} ${TICKET_JOINS}
           where t.org_id = $1 and t.user_id = $2
             and (t.is_confidential = false or t.user_id = $2)
             and (t.created_at, t.id) < ($3, $4)
           order by t.created_at desc, t.id desc limit 21`,
  },
  {
    id: "helpdesk-search-probe",
    ceiling: 2000,
    params: () => [],
    text: `select app.search_helpdesk_ticket_ids('provident fund transfer', 501) as id`,
  },
  {
    id: "helpdesk-search-probe-miss",
    ceiling: 2000,
    params: () => [],
    text: `select app.search_helpdesk_ticket_ids('zzzznomatchzzzz', 501) as id`,
  },
  {
    id: "helpdesk-search-ilike-baseline",
    ceiling: Number.MAX_SAFE_INTEGER,
    baseline: true,
    params: () => [ORG],
    text: `select t.id from helpdesk_tickets t
           where t.org_id = $1
             and (t.title ILIKE '%provident fund transfer%' or t.description ILIKE '%provident fund transfer%')
           limit 501`,
  },
  {
    id: "helpdesk-search-miss-baseline",
    ceiling: Number.MAX_SAFE_INTEGER,
    baseline: true,
    params: () => [ORG],
    text: `select t.id from helpdesk_tickets t
           where t.org_id = $1
             and (t.title ILIKE '%zzzznomatchzzzz%' or t.description ILIKE '%zzzznomatchzzzz%')
           limit 501`,
  },
];

const CHECKS = [
  {
    id: "reviews-page-1",
    ceiling: 2000,
    requireIndexOn: "performance_reviews",
    params: () => [ORG],
    text: `select ${REVIEW_COLUMNS} ${REVIEW_JOINS}
           where pr.org_id = $1
           order by pr.created_at desc, pr.id desc limit 51`,
  },
  {
    id: "reviews-page-deep-cursor",
    ceiling: 2000,
    requireIndexOn: "performance_reviews",
    params: (f) => [ORG, f.deepCreatedAt, f.deepId],
    text: `select ${REVIEW_COLUMNS} ${REVIEW_JOINS}
           where pr.org_id = $1 and (pr.created_at, pr.id) < ($2, $3)
           order by pr.created_at desc, pr.id desc limit 51`,
  },
  {
    id: "reviews-own-scope-cursor",
    ceiling: 2000,
    requireIndexOn: "performance_reviews",
    params: (f) => [ORG, f.subjectUserId, f.deepCreatedAt, f.deepId],
    text: `select ${REVIEW_COLUMNS} ${REVIEW_JOINS}
           where pr.org_id = $1 and pr.user_id = $2 and (pr.created_at, pr.id) < ($3, $4)
           order by pr.created_at desc, pr.id desc limit 51`,
  },
  {
    id: "reviews-offset-baseline",
    ceiling: Number.MAX_SAFE_INTEGER,
    baseline: true,
    params: () => [ORG],
    text: `select ${REVIEW_COLUMNS} ${REVIEW_JOINS}
           where pr.org_id = $1
           order by pr.created_at desc limit 50 offset 5000`,
  },
];

CHECKS.push(...HELPDESK_CHECKS);

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
    const [deep] = await tx`
      select created_at, id, user_id from performance_reviews
      where org_id = ${ORG} order by created_at desc, id desc offset 5000 limit 1`;
    const [total] = await tx`
      select count(*)::int n from performance_reviews where org_id = ${ORG}`;
    const [ticket] = await tx`
      select created_at, id, user_id from helpdesk_tickets
      where org_id = ${ORG} order by created_at desc, id desc offset 5000 limit 1`;
    const [ticketTotal] = await tx`
      select count(*)::int n from helpdesk_tickets where org_id = ${ORG}`;
    return {
      ticketCreatedAt: ticket.created_at.toISOString().replace("T", " ").replace("Z", ""),
      ticketId: ticket.id,
      ticketOwnerId: ticket.user_id,
      ticketTotal: ticketTotal.n,
      deepCreatedAt: deep.created_at.toISOString().replace("T", " ").replace("Z", ""),
      deepId: deep.id,
      subjectUserId: deep.user_id,
      total: total.n,
    };
  });

  console.log(`org ${ORG} · ${fixtures.total} performance reviews · cursor at row 5000`);
  console.log(`org ${ORG} · ${fixtures.ticketTotal} helpdesk tickets · cursor at row 5000`);
  console.log("cursor bound is passed as the driver text form drizzle produces for a timestamp column");

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
    const nodes = walk(root, []);
    const target = nodes.find((n) => n.relation === check.requireIndexOn);
    const sorted = nodes.slice(0, 3).some((n) => n.type === "Sort" || n.type === "Incremental Sort");

    console.log(
      `${check.id.padEnd(28)} blocks=${String(blocks).padStart(8)} ` +
        `${check.baseline ? "(baseline)" : `(ceiling ${check.ceiling})`} ` +
        `${target ? `${target.type}${target.index ? ` using ${target.index}` : ""}` : ""}` +
        `${sorted ? " SORT" : ""}`,
    );

    if (check.baseline) continue;
    if (blocks > check.ceiling) failures.push(`${check.id}: ${blocks} blocks > ${check.ceiling}`);
    if (!check.requireIndexOn) {
      continue;
    }
    if (!target) {
      failures.push(`${check.id}: no ${check.requireIndexOn} node — the query shape changed`);
    } else if (!target.type.includes("Index")) {
      failures.push(
        `${check.id}: ${check.requireIndexOn} resolved by ${target.type} — the tenant-led keyset index is missing or unusable`,
      );
    }
    if (sorted && blocks > check.ceiling / 4) {
      failures.push(
        `${check.id}: sorted ${blocks} blocks worth of rows before the limit — the index is not carrying the page order`,
      );
    }
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
