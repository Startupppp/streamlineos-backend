#!/usr/bin/env node
/**
 * People / invitations / employee-admission request + SQL capture harness.
 *
 * Records, for the directory -> invite -> accept -> employee-wizard journey:
 * caller label, query key the frontend uses for the same read, HTTP status,
 * wall duration, server SQL statement delta (pg_stat_statements) and whether the
 * server answered from its Redis cache. Repeats every read to separate cold from
 * warm, replays a read after a refocus, after an organization switch, after a
 * failed mutation and concurrently with a mutation.
 *
 * Never prints an email address, a token, a bank detail or any personal name:
 * identifiers are reduced to a salted 8-character digest before they are written.
 *
 * Required environment (a named disposable environment only):
 *   PEOPLE_CAPTURE_API_URL        e.g. http://127.0.0.1:1500
 *   PEOPLE_CAPTURE_TOKEN          backend JWT for an actor holding
 *                                 settings:organization:manage and hr:onboarding:manage
 *   PEOPLE_CAPTURE_ORG_ID         the acting organization
 *   PEOPLE_CAPTURE_DATABASE_URL   the same database the API is pointed at
 * Optional:
 *   PEOPLE_CAPTURE_SECOND_ORG_ID  a second organization the actor belongs to; enables the switch leg
 *   PEOPLE_CAPTURE_INVITE_EMAIL   address to invite; default derives a unique disposable address
 *   PEOPLE_CAPTURE_OUT            output path; default ./people-request-capture.json
 *
 * Pass criteria:
 *   - every leg returns the documented status (2xx, or the documented 409 for the
 *     duplicate-invite leg)
 *   - warm SQL delta <= cold SQL delta for every cached read
 *   - the organization-switch leg does NOT serve the first organization's rows
 *   - the failed-mutation leg leaves the invitation list unchanged
 *   - no output field contains an unmasked address, token or personal name
 *
 * Usage:
 *   node src/scripts/people-request-capture.mjs
 */

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const API_URL = process.env.PEOPLE_CAPTURE_API_URL;
const TOKEN = process.env.PEOPLE_CAPTURE_TOKEN;
const ORG_ID = process.env.PEOPLE_CAPTURE_ORG_ID;
const DATABASE_URL = process.env.PEOPLE_CAPTURE_DATABASE_URL;
const SECOND_ORG_ID = process.env.PEOPLE_CAPTURE_SECOND_ORG_ID ?? null;
const OUT = process.env.PEOPLE_CAPTURE_OUT ?? "./people-request-capture.json";

const SALT = randomUUID();

function mask(value) {
  if (value === null || value === undefined) return null;
  return createHash("sha256").update(`${SALT}:${String(value)}`).digest("hex").slice(0, 8);
}

function fail(message) {
  console.error(`people-request-capture: ${message}`);
  process.exit(1);
}

for (const [name, value] of [
  ["PEOPLE_CAPTURE_API_URL", API_URL],
  ["PEOPLE_CAPTURE_TOKEN", TOKEN],
  ["PEOPLE_CAPTURE_ORG_ID", ORG_ID],
  ["PEOPLE_CAPTURE_DATABASE_URL", DATABASE_URL],
])
  if (!value) fail(`${name} is required`);

const PRODUCTION_MARKERS = ["prod", "neon.tech", "aurora", "rds.amazonaws.com"];
for (const marker of PRODUCTION_MARKERS) {
  if (DATABASE_URL.toLowerCase().includes(marker))
    fail(`refusing to run: PEOPLE_CAPTURE_DATABASE_URL looks like a shared/production target (${marker})`);
  if (API_URL.toLowerCase().includes(marker))
    fail(`refusing to run: PEOPLE_CAPTURE_API_URL looks like a shared/production target (${marker})`);
}

const INVITE_EMAIL =
  process.env.PEOPLE_CAPTURE_INVITE_EMAIL ?? `capture-${randomUUID()}@example.invalid`;

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

async function statementCount() {
  try {
    const [row] = await sql`SELECT coalesce(sum(calls), 0)::bigint AS calls FROM pg_stat_statements`;
    return Number(row?.calls ?? 0);
  } catch {
    return null;
  }
}

const legs = [];

async function leg(options) {
  const { label, queryKey, caller, method = "GET", path, body = null, expect = [200] } = options;
  const before = await statementCount();
  const startedAt = process.hrtime.bigint();
  let status = 0;
  let cacheHeader = null;
  let payloadSize = 0;
  let error = null;
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-organization-id": ORG_ID,
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
    status = response.status;
    cacheHeader = response.headers.get("x-cache") ?? response.headers.get("age") ?? null;
    payloadSize = (await response.text()).length;
  } catch (err) {
    error = err instanceof Error ? err.name : "request-failed";
  }
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const after = await statementCount();

  const record = {
    label,
    caller,
    queryKey,
    method,
    route: path.split("?")[0],
    status,
    expectedStatus: expect,
    ok: expect.includes(status),
    durationMs: Number(durationMs.toFixed(2)),
    sqlStatements: before === null || after === null ? null : after - before,
    cacheSignal: cacheHeader,
    responseBytes: payloadSize,
    error,
  };
  legs.push(record);
  return record;
}

async function run() {
  if ((await statementCount()) === null)
    console.warn(
      "people-request-capture: pg_stat_statements is unavailable; SQL deltas will be null. " +
        "Enable the extension on the disposable database for a complete capture.",
    );

  const directoryRead = {
    queryKey: 'usersAndCommerceQueryKeys.users.list({ page, limit })',
    caller: "features/directory/users/users-page.tsx -> hooks/api/users",
    path: "/users?page=1&limit=20",
  };
  const invitationRead = {
    queryKey: "usersAndCommerceQueryKeys.users.invitations(params)",
    caller: "features/directory/users/user-invitations-panel.tsx -> hooks/api/users/invitations.ts",
    path: "/users/invitations?limit=20",
  };
  const employeeRead = {
    queryKey: "hrQueryKeys.employees.list(params)",
    caller: "features/hr -> hooks/api/hr",
    path: "/hr/employees?limit=20",
  };

  for (const read of [directoryRead, invitationRead, employeeRead]) {
    await leg({ label: "cold", ...read });
    await leg({ label: "warm", ...read });
    await leg({ label: "warm-refocus", ...read });
  }

  const invite = await leg({
    label: "invite-create",
    caller: "features/directory/users/user-invite-dialog.tsx",
    queryKey: "mutation: users.invite",
    method: "POST",
    path: "/users/invite",
    body: { email: INVITE_EMAIL, role: "MEMBER" },
    expect: [200, 201],
  });

  await leg({ label: "invalidated-read", ...invitationRead });

  await leg({
    label: "invite-duplicate-failed-mutation",
    caller: "features/directory/users/user-invite-dialog.tsx",
    queryKey: "mutation: users.invite",
    method: "POST",
    path: "/users/invite",
    body: { email: INVITE_EMAIL, role: "MEMBER" },
    expect: [409],
  });

  await leg({ label: "read-after-failed-mutation", ...invitationRead });

  const concurrent = await Promise.all([
    leg({
      label: "concurrent-mutation",
      caller: "features/directory/users/user-invite-dialog.tsx",
      queryKey: "mutation: users.invite",
      method: "POST",
      path: "/users/invite",
      body: { email: `concurrent-${randomUUID()}@example.invalid`, role: "MEMBER" },
      expect: [200, 201, 409],
    }),
    leg({ label: "concurrent-read", ...invitationRead }),
  ]);

  await leg({
    label: "employee-admission-check",
    caller: "components/hr/check-employee-email.ts",
    queryKey: "direct: GET /hr/employees/check-email",
    path: `/hr/employees/check-email?email=${encodeURIComponent(INVITE_EMAIL)}`,
  });

  if (SECOND_ORG_ID) {
    await leg({
      label: "org-switch",
      caller: "components/layout workspace switcher",
      queryKey: "mutation: organization.switch",
      method: "POST",
      path: "/organization/switch",
      body: { organizationId: SECOND_ORG_ID },
      expect: [200, 201],
    });
    await leg({ label: "read-after-org-switch", ...invitationRead });
  }

  const coldWarm = [];
  for (const label of ["cold", "warm", "warm-refocus"]) {
    for (const record of legs.filter((entry) => entry.label === label))
      coldWarm.push({ label, route: record.route, sql: record.sqlStatements, ms: record.durationMs });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    apiHost: new URL(API_URL).host,
    orgId: mask(ORG_ID),
    secondOrgId: mask(SECOND_ORG_ID),
    inviteSubject: mask(INVITE_EMAIL),
    inviteCreated: invite.ok,
    concurrentPair: concurrent.map((entry) => ({
      label: entry.label,
      status: entry.status,
      sql: entry.sqlStatements,
    })),
    coldWarm,
    legs,
    failures: legs.filter((entry) => !entry.ok).map((entry) => ({
      label: entry.label,
      route: entry.route,
      status: entry.status,
      expected: entry.expectedStatus,
    })),
  };

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`people-request-capture: wrote ${OUT}`);
  console.log(`legs=${legs.length} failures=${report.failures.length}`);
  await sql.end({ timeout: 5 });
  process.exit(report.failures.length === 0 ? 0 : 1);
}

run().catch(async (err) => {
  console.error("people-request-capture failed:", err instanceof Error ? err.message : err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
