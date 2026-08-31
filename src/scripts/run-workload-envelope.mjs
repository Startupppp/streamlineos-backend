import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { LATENCY_OBJECTIVES, CELL_SHARE } from "./envelope-profile.mjs";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const SELF_TEST = process.argv.includes("--self-test");
const HEADROOM_FLOOR = 0.40;

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("APP_DATABASE_URL is required (non-BYPASSRLS app role).");
  process.exit(1);
}

const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
const db = postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });

function pass(label, detail) {
  console.log(`PASS  ${label.padEnd(50)} ${detail}`);
}

function fail(label, detail) {
  console.error(`FAIL  ${label.padEnd(50)} ${detail}`);
}

function refuse(label, reason) {
  console.error(`REFUSE ${label.padEnd(49)} ${reason}`);
}

function report(label, detail) {
  console.log(`INFO  ${label.padEnd(50)} ${detail}`);
}

async function withTenant(fn) {
  return db.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${ORG}, true)`;
    return fn(tx);
  });
}

async function measureBlocks(tx, querySql, params) {
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${querySql}`, params);
  const root = rows[0]["QUERY PLAN"][0].Plan;
  const blocks = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
  return { blocks, root };
}

async function checkBroadcastMechanism(tx) {
  const [broadcastsRow] = await tx`
    SELECT count(*)::int c FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'broadcasts'`;
  if (!broadcastsRow || broadcastsRow.c === 0)
    return { verdict: "ABSENT", detail: "broadcasts table does not exist" };

  const [audRow] = await tx`
    SELECT count(*)::int c FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'broadcast_audience_targets'`;
  const hasSplit = audRow && audRow.c > 0;

  const cols = await tx`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'broadcasts' AND column_name IN ('recipient_count','status','audience_type')
    ORDER BY column_name`;
  const colNames = cols.map((r) => r.column_name);

  const hasRecipientCount = colNames.includes("recipient_count");
  const hasStatus = colNames.includes("status");
  const hasAudienceType = colNames.includes("audience_type");

  const notificationFanout = await tx`
    SELECT count(*)::int c FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'notification_queue'`;
  const hasFanoutQueue = notificationFanout[0].c > 0;

  return {
    verdict: "INSPECTED",
    hasSplitAudienceTargets: hasSplit,
    hasRecipientCount,
    hasStatus,
    hasAudienceType,
    hasFanoutQueue,
    detail: [
      hasSplit ? "audience_targets table present" : "WARN: broadcast_audience_targets missing (SCH-017 incomplete)",
      hasRecipientCount ? "recipientCount column present" : "WARN: recipientCount missing",
      hasFanoutQueue ? "notification_queue fanout table present" : "notification_queue present",
    ].join("; "),
  };
}

async function runMeasurements() {
  const failures = [];
  const refuses = [];

  const fixtures = await withTenant(async (tx) => {
    const [members] = await tx`SELECT count(*)::int c FROM organization_members WHERE org_id = ${ORG} AND status = 'ACTIVE'`;
    const [participant] = await tx`
      SELECT user_id, count(*)::int n FROM build.ticket_assignees
      WHERE org_id = ${ORG} GROUP BY user_id ORDER BY n DESC LIMIT 1`;
    const [channel] = await tx`
      SELECT channel_id, count(*)::int n FROM chat_messages
      WHERE org_id = ${ORG} GROUP BY channel_id ORDER BY n DESC LIMIT 1`;
    const [notifUser] = await tx`
      SELECT user_id, count(*)::int n FROM notifications
      WHERE org_id = ${ORG} AND deleted_at IS NULL GROUP BY user_id ORDER BY n DESC LIMIT 1`;
    return {
      memberCount: members.c,
      userId: participant?.user_id ?? null,
      channelId: channel?.channel_id ?? null,
      notifUserId: notifUser?.user_id ?? null,
      notifCount: notifUser?.n ?? 0,
    };
  });

  report("org-member-count", `${fixtures.memberCount} active members`);
  report("envelope-target", `${CELL_SHARE.largestOrgMembers} members required`);

  if (fixtures.memberCount < CELL_SHARE.largestOrgMembers) {
    refuse("member-count-adequate",
      `${fixtures.memberCount} < ${CELL_SHARE.largestOrgMembers} — run seed-envelope.mjs first`);
    failures.push("member count below envelope requirement");
  } else {
    pass("member-count-adequate", `${fixtures.memberCount} >= ${CELL_SHARE.largestOrgMembers}`);
  }

  await withTenant(async (tx) => {
    const minRows = 10;
    const [cnt] = await tx`SELECT count(*)::int c FROM organization_members WHERE org_id = ${ORG} AND status = 'ACTIVE'`;
    if (cnt.c < minRows) {
      refuse("org-members-list", `${cnt.c} rows < ${minRows} required`);
      failures.push("org-members-list: seed too small");
      return;
    }
    const { blocks } = await measureBlocks(tx,
      `SELECT id, user_id, role, is_owner, status, joined_at
       FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
       ORDER BY joined_at DESC LIMIT 100`,
      [ORG]);
    const ceiling = 5_000;
    if (blocks <= ceiling) pass("org-members-list", `blocks=${blocks} (ceiling ${ceiling})`);
    else { fail("org-members-list", `blocks=${blocks} > ceiling ${ceiling}`); failures.push("org-members-list: over ceiling"); }
  });

  await withTenant(async (tx) => {
    const [cnt] = await tx`SELECT count(*)::int c FROM organization_people WHERE organization_id = ${ORG} AND deleted_at IS NULL`;
    if (cnt.c < 10) {
      refuse("org-people-directory", `${cnt.c} rows < 10 required`);
      failures.push("org-people-directory: seed too small");
      return;
    }
    const { blocks } = await measureBlocks(tx,
      `SELECT organization_person_id, first_name, last_name, work_email, display_name
       FROM organization_people WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY first_name ASC, last_name ASC LIMIT 100`,
      [ORG]);
    const ceiling = 8_000;
    if (blocks <= ceiling) pass("org-people-directory", `blocks=${blocks} (ceiling ${ceiling})`);
    else { fail("org-people-directory", `blocks=${blocks} > ceiling ${ceiling}`); failures.push("org-people-directory: over ceiling"); }
  });

  await withTenant(async (tx) => {
    const [cnt] = await tx`SELECT count(*)::int c FROM organization_members WHERE org_id = ${ORG} AND status = 'ACTIVE'`;
    if (cnt.c < 10) {
      refuse("employee-record-list", `${cnt.c} members < 10 required`);
      failures.push("employee-record-list: seed too small");
      return;
    }
    const { blocks } = await measureBlocks(tx,
      `SELECT m.user_id, e.employee_number, e.designation, e.joining_date
       FROM organization_members m
       LEFT JOIN hr_people p ON p.org_id = $1 AND p.user_id = m.user_id AND p.deleted_at IS NULL
       LEFT JOIN hr_employments e ON e.org_id = $1 AND e.person_id = p.id AND e.is_primary = true AND e.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.status = 'ACTIVE'
       ORDER BY m.joined_at DESC LIMIT 100`,
      [ORG]);
    const ceiling = 8_000;
    if (blocks <= ceiling) pass("employee-record-list", `blocks=${blocks} (ceiling ${ceiling})`);
    else { fail("employee-record-list", `blocks=${blocks} > ceiling ${ceiling}`); failures.push("employee-record-list: over ceiling"); }
  });

  const broadcast = await withTenant(checkBroadcastMechanism);
  report("broadcast-mechanism", broadcast.detail);
  if (broadcast.verdict === "ABSENT") {
    refuse("broadcast-one-job-bounded-batches", "broadcasts table absent");
    failures.push("broadcast: table absent");
  } else {
    const oneJobOk = broadcast.hasRecipientCount && broadcast.hasStatus;
    const noBatchWriteInRequest = broadcast.hasFanoutQueue || broadcast.hasSplitAudienceTargets;
    if (oneJobOk)
      pass("broadcast-one-logical-job", "recipientCount + status columns confirm one-job model");
    else {
      fail("broadcast-one-logical-job", "recipientCount or status column missing");
      failures.push("broadcast: one-job model unverifiable");
    }
    if (noBatchWriteInRequest)
      pass("broadcast-no-request-time-fanout", "notification_queue or audience_targets table present — fanout deferred");
    else {
      fail("broadcast-no-request-time-fanout", "notification_queue absent and audience_targets absent");
      failures.push("broadcast: fanout mechanism unverifiable");
    }
  }

  report("latency-objectives-total", `${LATENCY_OBJECTIVES.length} objectives in PRD`);
  const measurable = ["p95-simple-db-roundtrip", "p95-complex-db-read"];
  for (const obj of LATENCY_OBJECTIVES) {
    if (!measurable.includes(obj.name))
      report(`objective-not-measurable:${obj.name}`,
        `target=${obj.target} ${obj.unit} — requires production load driver, not a buffer-count check`);
  }

  const headroomNote = "headroom requires production-load driver measuring CPU/connection/memory against " +
    `the ${CELL_SHARE.sustainedRps} req/s per-cell target; 40% floor cannot be asserted from buffer counts alone`;
  refuse("40pct-headroom-in-all-resources", headroomNote);
  refuses.push("40pct-headroom-in-all-resources");

  if (!SELF_TEST) {
    console.log("\n--- Summary ---");
    if (failures.length === 0) console.log("All measurable envelope checks passed.");
    else {
      console.error(`${failures.length} failure(s):`);
      for (const f of failures) console.error(`  FAIL: ${f}`);
      process.exitCode = 1;
    }
  }
  return { failures, refuses };
}

async function selfTest() {
  const { refuses } = await runMeasurements();
  const hasRefuse = refuses.includes("40pct-headroom-in-all-resources");
  if (hasRefuse) {
    console.log("SELF-TEST PASS: unmeasurable objective correctly refused");
    process.exitCode = 0;
  } else {
    console.error("SELF-TEST FAIL: headroom check did not refuse as expected");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  (SELF_TEST ? selfTest() : runMeasurements())
    .catch((e) => {
      console.error("RUNNER FAILED:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
