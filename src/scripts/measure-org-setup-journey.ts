/**
 * First-usable-organization journey measurement for the org-setup lane (OS-R6).
 *
 * Spans captured per sample, all from the instant `POST /org/setup/complete` is sent:
 *   completeMs        the create/setup request itself (target resolution + setup transaction)
 *   commitToClaimMs   commit to the relay's first durable signal on the setup outbox event
 *   consumerMs        the consumer's own phases, read from `inbox_records`
 *   readyMs           to the first `GET /org/setup/status` reporting `ready: true`
 *                     -- this is FIRST-USABLE-ORG, the span the p95 target applies to
 *   usableColdMs      an authenticated read on the new org with nothing cached
 *   usableWarmMs      the same read repeated immediately
 *
 * The working engineering target is p95 readyMs <= 10s (index standing answer). It is a target,
 * not a customer SLA, and this script reports the dataset, sample size and both scenarios rather
 * than a single number.
 *
 * NOT run by this lane. Coordinator-run against a named disposable environment:
 *
 *   SETUP_MEASUREMENT_ENV=scratch_local \
 *   SETUP_API_BASE_URL=http://127.0.0.1:1600 \
 *   APP_DATABASE_URL=postgresql://streamline_app:...@127.0.0.1:5432/scratch_local \
 *   SETUP_JWT_TOKEN_FILE=./setup-tokens.txt \
 *     node -r ts-node/register/transpile-only src/scripts/measure-org-setup-journey.ts
 *
 * `SETUP_JWT_TOKEN_FILE` holds one raw JWT bearer token per line, each minted for a DISTINCT
 * freshly registered user that holds no organization. One token is consumed per sample: setup
 * creates an organization per call, so re-using an identity measures a replay, not a journey.
 * Token files must be stored outside the repository. Token values are never logged.
 *
 * ZEPTOMAIL_TOKEN and RESEND_API_KEY must be absent so the stack sends no real email.
 * The harness refuses to proceed if either credential is present.
 *
 * This script creates organizations via POST /org/setup/complete. It does not create user accounts.
 *
 *   --self-test   exercise the pure aggregation and refusal logic only; no network, no database.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { percentile } from "./benchmark-statistics";

export interface SpanSample {
  completeMs: number;
  commitToClaimMs: number | null;
  consumerMs: number | null;
  readyMs: number | null;
  usableColdMs: number | null;
  usableWarmMs: number | null;
  sqlCalls: number | null;
}

export interface ScenarioReport {
  scenario: string;
  samples: number;
  spans: Record<string, { p50: number | null; p95: number | null; min: number | null; max: number | null }>;
  incomplete: number;
}

const SPAN_KEYS = [
  "completeMs",
  "commitToClaimMs",
  "consumerMs",
  "readyMs",
  "usableColdMs",
  "usableWarmMs",
  "sqlCalls",
] as const;

export const FIRST_USABLE_ORG_TARGET_MS = 10_000;
const CONSUMER_NAME = "organization:setup-completed";
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 120_000;
const PREFLIGHT_TIMEOUT_MS = 10_000;

export function summarise(scenario: string, samples: readonly SpanSample[]): ScenarioReport {
  const spans: ScenarioReport["spans"] = {};
  for (const key of SPAN_KEYS) {
    const values = samples
      .map((sample) => sample[key])
      .filter((value): value is number => value !== null && Number.isFinite(value))
      .sort((a, b) => a - b);
    spans[key] = {
      p50: percentile(values, 50) ?? null,
      p95: percentile(values, 95) ?? null,
      min: values[0] ?? null,
      max: values[values.length - 1] ?? null,
    };
  }
  return {
    scenario,
    samples: samples.length,
    spans,
    incomplete: samples.filter((sample) => sample.readyMs === null).length,
  };
}

export function targetVerdict(
  reports: readonly ScenarioReport[],
): { verdict: "MET" | "BREACHED" | "INCONCLUSIVE"; exitCode: 0 | 1 } {
  if (reports.length === 0) return { verdict: "INCONCLUSIVE", exitCode: 1 };
  for (const report of reports) {
    if (report.samples === 0 || report.incomplete > 0)
      return { verdict: "INCONCLUSIVE", exitCode: 1 };
    const p95 = report.spans["readyMs"]?.p95;
    if (p95 === null || p95 === undefined) return { verdict: "INCONCLUSIVE", exitCode: 1 };
    if (p95 > FIRST_USABLE_ORG_TARGET_MS) return { verdict: "BREACHED", exitCode: 1 };
  }
  return { verdict: "MET", exitCode: 0 };
}

export interface TargetRefusal {
  allowed: boolean;
  reason: string;
}

export function assertDisposableTarget(
  databaseUrl: string,
  namedEnvironment: string | undefined,
  allowRemote: boolean,
): TargetRefusal {
  if (!namedEnvironment)
    return { allowed: false, reason: "SETUP_MEASUREMENT_ENV names the disposable environment and is required" };
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { allowed: false, reason: "APP_DATABASE_URL is not a URL" };
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (database !== namedEnvironment)
    return {
      allowed: false,
      reason: `database '${database}' does not match SETUP_MEASUREMENT_ENV '${namedEnvironment}'`,
    };
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (!loopback && !allowRemote)
    return {
      allowed: false,
      reason: `host '${parsed.hostname}' is not loopback; set SETUP_ALLOW_REMOTE=1 only for an identified test target`,
    };
  return { allowed: true, reason: `${database}@${parsed.hostname}` };
}

export function assertDisposableApiTarget(
  apiBaseUrl: string | undefined,
  allowRemote: boolean,
): TargetRefusal {
  if (!apiBaseUrl)
    return { allowed: false, reason: "SETUP_API_BASE_URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    return { allowed: false, reason: "SETUP_API_BASE_URL is not a valid URL" };
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (!loopback && !allowRemote)
    return {
      allowed: false,
      reason: `API host '${parsed.hostname}' is not loopback; set SETUP_ALLOW_REMOTE=1 only for an identified test target`,
    };
  return { allowed: true, reason: `api@${parsed.hostname}:${parsed.port || "default"}` };
}

export function assertEmailTransportDisabled(env: Record<string, string | undefined>): TargetRefusal {
  const zepto = env["ZEPTOMAIL_TOKEN"] ?? "";
  const resend = env["RESEND_API_KEY"] ?? "";
  if (zepto || resend)
    return {
      allowed: false,
      reason: "email transport credentials must be absent on a measurement stack; unset ZEPTOMAIL_TOKEN and RESEND_API_KEY",
    };
  return { allowed: true, reason: "email transport disabled" };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function readTokens(): string[] {
  const path = required("SETUP_JWT_TOKEN_FILE");
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    console.error(`${path} contains no token lines`);
    process.exit(1);
  }
  return lines;
}

function setupBody(inviteeCount: number): Record<string, unknown> {
  return {
    companyName: `Measurement Org ${Date.now()}`,
    industry: "IT Services",
    companySize: "1-10",
    enabledModules: ["hr", "crm", "build"],
    invitees: Array.from({ length: inviteeCount }, (_, index) => ({
      email: `measure+${Date.now()}-${index}@example.invalid`,
      role: "MEMBER",
    })),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function verifyApiRefusesUnauthenticated(baseUrl: string): Promise<void> {
  const noAuth = await fetchWithTimeout(
    `${baseUrl}/org/setup/status`,
    {},
    PREFLIGHT_TIMEOUT_MS,
  );
  if (noAuth.status !== 401 && noAuth.status !== 403)
    throw new Error(`preflight: expected 401 or 403 without credentials, got ${noAuth.status}`);

  const badToken = await fetchWithTimeout(
    `${baseUrl}/org/setup/status`,
    { headers: { Authorization: "Bearer invalid.preflight.token" } },
    PREFLIGHT_TIMEOUT_MS,
  );
  if (badToken.status !== 401 && badToken.status !== 403)
    throw new Error(`preflight: expected 401 or 403 with invalid token, got ${badToken.status}`);
}

async function postComplete(
  baseUrl: string,
  token: string,
  inviteeCount: number,
): Promise<{ orgId: string; elapsedMs: number; startedAt: number }> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/org/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(setupBody(inviteeCount)),
  });
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok)
    throw new Error(`POST /org/setup/complete responded ${response.status}`);
  const parsed: unknown = await response.json();
  const data =
    typeof parsed === "object" && parsed !== null
      ? (Reflect.get(parsed, "data") ?? parsed)
      : null;
  const orgId = typeof data === "object" && data !== null ? Reflect.get(data, "orgId") : null;
  if (typeof orgId !== "string")
    throw new Error("POST /org/setup/complete returned no orgId");
  return { orgId, elapsedMs, startedAt };
}

async function pollUntilReady(
  baseUrl: string,
  token: string,
  startedAt: number,
): Promise<number | null> {
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const response = await fetch(`${baseUrl}/org/setup/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      const parsed: unknown = await response.json();
      const data =
        typeof parsed === "object" && parsed !== null
          ? (Reflect.get(parsed, "data") ?? parsed)
          : null;
      const ready = typeof data === "object" && data !== null ? Reflect.get(data, "ready") : null;
      if (ready === true) return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

async function timedGet(baseUrl: string, token: string, path: string): Promise<number | null> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  await response.arrayBuffer();
  return Date.now() - startedAt;
}

type Sql = ReturnType<typeof postgres>;

async function waitForDurableClaim(
  sql: Sql,
  orgId: string,
  startedAt: number,
): Promise<number | null> {
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const rows = await sql`
      SELECT delivery_state, retry_count
      FROM outbox_events
      WHERE organization_id = ${orgId}
        AND aggregate_type = 'organization'
        AND aggregate_id = ${orgId}
        AND event_type = 'organization.setup.completed'
      ORDER BY aggregate_version DESC
      LIMIT 1`;
    const row = rows[0];
    if (row) {
      const state = String(row["delivery_state"]);
      const retries = Number(row["retry_count"] ?? 0);
      if (retries > 0 || state === "DELIVERED" || state === "DEAD" || state === "SUPPRESSED")
        return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

async function consumerSpanMs(sql: Sql, orgId: string): Promise<number | null> {
  const rows = await sql`
    SELECT created_at, processed_at
    FROM inbox_records
    WHERE organization_id = ${orgId}
      AND consumer_name = ${CONSUMER_NAME}
      AND aggregate_type = 'organization'
      AND aggregate_id = ${orgId}
    ORDER BY aggregate_version DESC
    LIMIT 1`;
  const row = rows[0];
  if (!row || !row["processed_at"] || !row["created_at"]) return null;
  return (
    new Date(String(row["processed_at"])).getTime() -
    new Date(String(row["created_at"])).getTime()
  );
}

async function statementCalls(sql: Sql): Promise<number | null> {
  try {
    const rows = await sql`SELECT coalesce(sum(calls), 0)::bigint AS calls FROM pg_stat_statements`;
    return Number(rows[0]?.["calls"] ?? 0);
  } catch {
    return null;
  }
}

async function describeDataset(sql: Sql): Promise<string> {
  const rows = await sql`
    SELECT (SELECT count(*)::int FROM organizations) AS orgs,
           (SELECT count(*)::int FROM organization_members) AS members,
           (SELECT count(*)::int FROM outbox_events) AS outbox,
           (SELECT count(*)::int FROM inbox_records) AS inbox,
           (SELECT count(*)::int FROM modules_catalog) AS modules,
           pg_size_pretty(pg_database_size(current_database())) AS size`;
  const row = rows[0];
  if (!row) return "unknown";
  return (
    `${row["orgs"]} organisations, ${row["members"]} memberships, ` +
    `${row["outbox"]} outbox events, ${row["inbox"]} inbox records, ` +
    `${row["modules"]} catalog modules, database ${row["size"]}`
  );
}

async function runScenario(
  options: {
    baseUrl: string;
    usablePath: string;
    inviteeCount: number;
    tokens: readonly string[];
    createdOrgIds: string[];
  },
  sql: Sql,
): Promise<SpanSample[]> {
  const samples: SpanSample[] = [];
  for (const token of options.tokens) {
    const before = await statementCalls(sql);
    const { orgId, elapsedMs, startedAt } = await postComplete(
      options.baseUrl,
      token,
      options.inviteeCount,
    );
    options.createdOrgIds.push(orgId);
    const readyMs = await pollUntilReady(options.baseUrl, token, startedAt);
    const commitToClaimMs = await waitForDurableClaim(sql, orgId, startedAt);
    const consumerMs = await consumerSpanMs(sql, orgId);
    const usableColdMs = await timedGet(options.baseUrl, token, options.usablePath);
    const usableWarmMs = await timedGet(options.baseUrl, token, options.usablePath);
    const after = await statementCalls(sql);
    samples.push({
      completeMs: elapsedMs,
      commitToClaimMs,
      consumerMs,
      readyMs,
      usableColdMs,
      usableWarmMs,
      sqlCalls: before === null || after === null ? null : after - before,
    });
  }
  return samples;
}

function printReport(report: ScenarioReport): void {
  console.log(`\nscenario: ${report.scenario} (n=${report.samples}, incomplete=${report.incomplete})`);
  for (const key of SPAN_KEYS) {
    const span = report.spans[key];
    if (!span) continue;
    console.log(
      `  ${key.padEnd(16)} p50=${String(span.p50 ?? "n/a").padStart(10)} ` +
        `p95=${String(span.p95 ?? "n/a").padStart(10)} ` +
        `min=${String(span.min ?? "n/a").padStart(10)} max=${String(span.max ?? "n/a").padStart(10)}`,
    );
  }
}

function selfTest(): void {
  const complete: SpanSample[] = Array.from({ length: 20 }, (_, index) => ({
    completeMs: 100 + index,
    commitToClaimMs: 5,
    consumerMs: 40,
    readyMs: 1_000 + index * 10,
    usableColdMs: 200,
    usableWarmMs: 50,
    sqlCalls: 30,
  }));
  const met = summarise("met", complete);
  if (met.samples !== 20) throw new Error("self-test: sample count lost");
  if (targetVerdict([met]).verdict !== "MET")
    throw new Error("self-test: a sub-target p95 must report MET");

  const slow = summarise(
    "slow",
    complete.map((sample) => ({ ...sample, readyMs: 30_000 })),
  );
  if (targetVerdict([slow]).verdict !== "BREACHED")
    throw new Error("self-test: a 30s p95 must report BREACHED");

  const first = complete[0];
  if (!first) throw new Error("self-test: fixture is empty");
  const partial = summarise("partial", [{ ...first, readyMs: null }]);
  if (targetVerdict([partial]).verdict !== "INCONCLUSIVE")
    throw new Error("self-test: an unfinished sample must not report a verdict");
  if (targetVerdict([]).verdict !== "INCONCLUSIVE")
    throw new Error("self-test: zero scenarios must report INCONCLUSIVE");

  const dbRefusals: Array<[TargetRefusal, boolean]> = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "scratch_local", false), true],
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/streamlineos", "scratch_local", false), false],
    [assertDisposableTarget("postgresql://u:p@db.prod.example:5432/scratch_local", "scratch_local", false), false],
    [assertDisposableTarget("postgresql://u:p@db.test.example:5432/scratch_local", "scratch_local", true), true],
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", undefined, false), false],
    [assertDisposableTarget("not-a-url", "scratch_local", false), false],
  ];
  for (const [result, expected] of dbRefusals)
    if (result.allowed !== expected)
      throw new Error(`self-test: DB refusal mismatch — ${result.reason}`);

  const apiRefusals: Array<[TargetRefusal, boolean]> = [
    [assertDisposableApiTarget("http://127.0.0.1:1600", false), true],
    [assertDisposableApiTarget("http://localhost:1600", false), true],
    [assertDisposableApiTarget("http://api.prod.example:1600", false), false],
    [assertDisposableApiTarget(undefined, false), false],
    [assertDisposableApiTarget("not-a-url", false), false],
    [assertDisposableApiTarget("http://api.test.example:1600", true), true],
  ];
  for (const [result, expected] of apiRefusals)
    if (result.allowed !== expected)
      throw new Error(`self-test: API refusal mismatch — ${result.reason}`);

  const emailRefusals: Array<[TargetRefusal, boolean]> = [
    [assertEmailTransportDisabled({}), true],
    [assertEmailTransportDisabled({ ZEPTOMAIL_TOKEN: "token" }), false],
    [assertEmailTransportDisabled({ RESEND_API_KEY: "re_key" }), false],
    [assertEmailTransportDisabled({ ZEPTOMAIL_TOKEN: "a", RESEND_API_KEY: "b" }), false],
  ];
  for (const [result, expected] of emailRefusals)
    if (result.allowed !== expected)
      throw new Error(`self-test: email transport refusal mismatch — ${result.reason}`);

  console.log("measure-org-setup-journey self-test passed");
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const namedEnvironment = process.env["SETUP_MEASUREMENT_ENV"];
  const databaseUrl = required("APP_DATABASE_URL");
  const dbRefusal = assertDisposableTarget(
    databaseUrl,
    namedEnvironment,
    process.env["SETUP_ALLOW_REMOTE"] === "1",
  );
  if (!dbRefusal.allowed) {
    console.error(`refusing to measure: ${dbRefusal.reason}`);
    process.exit(1);
  }

  const apiBaseUrl = required("SETUP_API_BASE_URL");
  const apiRefusal = assertDisposableApiTarget(
    apiBaseUrl,
    process.env["SETUP_ALLOW_REMOTE"] === "1",
  );
  if (!apiRefusal.allowed) {
    console.error(`refusing to measure: ${apiRefusal.reason}`);
    process.exit(1);
  }

  const emailRefusal = assertEmailTransportDisabled(process.env);
  if (!emailRefusal.allowed) {
    console.error(`refusing to measure: ${emailRefusal.reason}`);
    process.exit(1);
  }

  const baseUrl = apiBaseUrl.replace(/\/$/, "");
  const usablePath = process.env["SETUP_USABLE_PAGE_PATH"] ?? "/me/access";
  const inviteeBatch = Number(process.env["SETUP_INVITEE_BATCH"] ?? 10);
  const tokens = readTokens();
  const half = Math.floor(tokens.length / 2);
  if (half === 0) {
    console.error("at least two token lines are required — one scenario each");
    process.exit(1);
  }

  console.log(`api target: ${apiRefusal.reason}`);
  console.log(`db target: ${dbRefusal.reason}`);

  await verifyApiRefusesUnauthenticated(baseUrl);
  console.log("preflight: API refuses unauthenticated and invalid-token requests");

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  const createdOrgIds: string[] = [];
  try {
    console.log(`dataset: ${await describeDataset(sql)}`);
    console.log(`usable-page read: GET ${usablePath}`);

    const noInvitees = await runScenario(
      { baseUrl, usablePath, inviteeCount: 0, tokens: tokens.slice(0, half), createdOrgIds },
      sql,
    );
    const withInvitees = await runScenario(
      { baseUrl, usablePath, inviteeCount: inviteeBatch, tokens: tokens.slice(half), createdOrgIds },
      sql,
    );

    const reports = [
      summarise("no invitees", noInvitees),
      summarise(`invitee batch (${inviteeBatch})`, withInvitees),
    ];
    for (const report of reports) printReport(report);

    const { verdict, exitCode } = targetVerdict(reports);
    console.log(
      `\nfirst-usable-org p95 target ${FIRST_USABLE_ORG_TARGET_MS}ms (engineering target, not an SLA): ${verdict}`,
    );
    process.exitCode = exitCode;
  } finally {
    const toClean = createdOrgIds.length;
    for (const orgId of createdOrgIds) {
      try {
        await sql`DELETE FROM organizations WHERE id = ${orgId}`;
      } catch {}
    }
    console.log(`cleanup: ${toClean} test organisations processed`);
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
