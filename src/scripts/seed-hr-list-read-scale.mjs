import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertDisposableTarget(url) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (matched) return { allowed: false, reason: `DATABASE_URL names production host '${matched}'` };
  let host, dbName;
  try {
    const u = new URL(url.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://"));
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    return { allowed: false, reason: "DATABASE_URL does not parse" };
  }
  if (host === "127.0.0.1" || host === "localhost") return { allowed: true, reason: `loopback target '${host}'` };
  if (/scratch|test/i.test(dbName)) return { allowed: true, reason: `scratch/test database '${dbName}'` };
  return { allowed: false, reason: `host '${host}' is not loopback and database '${dbName}' is not a scratch/test database` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local"), true],
    [assertDisposableTarget("postgresql://u:p@localhost:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/app"), false],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/scratch_test"), false],
    [assertDisposableTarget(null), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got ${verdict.reason}`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: seed-hr-list-read-scale target guard, 5 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

const MARKER = "hr-list-read-scale";

const args = process.argv.slice(2);
const mode = args.includes("--purge")
  ? "purge"
  : args.includes("--count")
    ? "count"
    : args.includes("--seed")
      ? "seed"
      : null;

if (!mode) {
  process.stderr.write("Pass one of --seed | --purge | --count\n");
  process.exit(2);
}

const numArg = (name, fallback) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`));
  return raw ? Number(raw.slice(name.length + 3)) : fallback;
};

const REVIEWS = numArg("reviews", 200000);
const TICKETS = numArg("tickets", 200000);
const DECOY = numArg("decoy", 20000);
const BATCH = numArg("batch", 25000);

const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const _hrSeedGuard = assertDisposableTarget(url);
if (!_hrSeedGuard.allowed) {
  process.stderr.write(
    `seed-hr-list-read-scale BLOCKED — ${_hrSeedGuard.reason}\n` +
    "  Set DATABASE_URL to a loopback or named scratch/test database before seeding.\n",
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

async function counts() {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM performance_reviews WHERE org_id = ${ORG}) AS reviews,
      (SELECT count(*)::int FROM helpdesk_tickets    WHERE org_id = ${ORG}) AS tickets,
      (SELECT count(*)::int FROM performance_reviews WHERE comments = ${MARKER}) AS seeded_reviews,
      (SELECT count(*)::int FROM helpdesk_tickets    WHERE resolution = ${MARKER}) AS seeded_tickets`;
  return row;
}

async function decoyOrg() {
  const [row] = await sql`
    SELECT o.id FROM organizations o
    WHERE o.id <> ${ORG}
      AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id)
    ORDER BY o.created_at ASC LIMIT 1`;
  return row?.id ?? null;
}

async function seedReviews(orgId, total) {
  for (let done = 0; done < total; done += BATCH) {
    const size = Math.min(BATCH, total - done);
    await sql`
      WITH pool AS (
        SELECT array_agg(user_id) AS ids
        FROM (SELECT user_id FROM organization_members WHERE org_id = ${orgId} ORDER BY id LIMIT 5000) s
      )
      INSERT INTO performance_reviews
        (org_id, user_id, reviewer_id, period_start, period_end, status, overall_rating, comments, created_at, updated_at)
      SELECT
        ${orgId},
        p.ids[1 + (g % array_length(p.ids, 1))],
        p.ids[1 + ((g * 7) % least(250, array_length(p.ids, 1)))],
        (date '2024-01-01' + ((g % 900) || ' days')::interval)::date,
        (date '2024-03-31' + ((g % 900) || ' days')::interval)::date,
        (ARRAY['DRAFT','IN_PROGRESS','COMPLETED','ARCHIVED'])[1 + (g % 4)]::review_status,
        round((1 + (g % 40) / 10.0)::numeric, 2),
        ${MARKER},
        now() - ((${done} + g) || ' seconds')::interval,
        now() - ((${done} + g) || ' seconds')::interval
      FROM generate_series(1, ${size}) g CROSS JOIN pool p`;
    process.stdout.write(`  reviews ${orgId}: ${done + size}/${total}
`);
  }
}

async function seedTickets(orgId, total) {
  for (let done = 0; done < total; done += BATCH) {
    const size = Math.min(BATCH, total - done);
    await sql`
      WITH pool AS (
        SELECT array_agg(user_id) AS ids
        FROM (SELECT user_id FROM organization_members WHERE org_id = ${orgId} ORDER BY id LIMIT 5000) s
      )
      INSERT INTO helpdesk_tickets
        (org_id, user_id, title, description, category, priority, status, assignee_id, is_confidential, resolution, created_at, updated_at)
      SELECT
        ${orgId},
        p.ids[1 + (g % array_length(p.ids, 1))],
        (ARRAY['Payslip missing for','Laptop replacement for','Address change request','Reimbursement query','Leave balance dispute','Provident fund transfer','Insurance card for','Shift swap request'])[1 + (g % 8)]
          || ' ' || (ARRAY['March','April','May','June','contractor','night shift','probation','relocation'])[1 + (g % 8)]
          || ' #' || (${done} + g),
        'Raised through the helpdesk fixture. Reference '
          || (ARRAY['payroll','benefits','equipment','compliance','travel','onboarding'])[1 + (g % 6)]
          || ' case number ' || (${done} + g),
        (ARRAY['policy_question','payroll_issue','document_request','leave_issue','benefits','it_access','confidential','other'])[1 + (g % 8)],
        (ARRAY['LOW','MEDIUM','HIGH','URGENT'])[1 + (g % 4)]::ticket_priority,
        (ARRAY['TODO','IN_PROGRESS','IN_REVIEW','DONE'])[1 + (g % 4)]::ticket_status,
        CASE WHEN g % 3 = 0 THEN p.ids[1 + ((g * 13) % least(40, array_length(p.ids, 1)))] ELSE NULL END,
        (g % 11 = 0),
        ${MARKER},
        now() - ((${done} + g) || ' seconds')::interval,
        now() - ((${done} + g) || ' seconds')::interval
      FROM generate_series(1, ${size}) g CROSS JOIN pool p`;
    process.stdout.write(`  tickets ${orgId}: ${done + size}/${total}
`);
  }
}

async function seed() {
  const decoy = await decoyOrg();
  process.stdout.write(`primary org ${ORG}\n`);
  await seedReviews(ORG, REVIEWS);
  await seedTickets(ORG, TICKETS);
  if (decoy && DECOY > 0) {
    process.stdout.write(`decoy org ${decoy}\n`);
    await seedReviews(decoy, DECOY);
    await seedTickets(decoy, DECOY);
  }
  process.stdout.write("VACUUM ANALYZE performance_reviews, helpdesk_tickets\n");
  await sql.unsafe("VACUUM ANALYZE performance_reviews");
  await sql.unsafe("VACUUM ANALYZE helpdesk_tickets");
  process.stdout.write(`${JSON.stringify(await counts())}\n`);
}

async function purge() {
  for (;;) {
    const deleted = await sql`
      DELETE FROM performance_reviews
      WHERE id IN (SELECT id FROM performance_reviews WHERE comments = ${MARKER} LIMIT 20000)
      RETURNING id`;
    process.stdout.write(`  reviews purged ${deleted.length}\n`);
    if (deleted.length === 0) break;
  }
  for (;;) {
    const deleted = await sql`
      DELETE FROM helpdesk_tickets
      WHERE id IN (SELECT id FROM helpdesk_tickets WHERE resolution = ${MARKER} LIMIT 20000)
      RETURNING id`;
    process.stdout.write(`  tickets purged ${deleted.length}\n`);
    if (deleted.length === 0) break;
  }
  await sql.unsafe("VACUUM ANALYZE performance_reviews");
  await sql.unsafe("VACUUM ANALYZE helpdesk_tickets");
}

const run = mode === "seed" ? seed : mode === "purge" ? purge : async () => {
  process.stdout.write(`${JSON.stringify(await counts())}\n`);
};

run()
  .catch((e) => {
    process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
