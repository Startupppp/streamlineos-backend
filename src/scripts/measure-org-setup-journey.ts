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
 *   SETUP_SESSION_COOKIE_FILE=./setup-cookies.txt \
 *     node -r ts-node/register/transpile-only src/scripts/measure-org-setup-journey.ts
 *
 * `SETUP_SESSION_COOKIE_FILE` holds one `Cookie:` header value per line, each for a DISTINCT
 * freshly registered user that holds no organization. One line is consumed per sample: setup is
 * idempotent per organisation, so re-using an identity measures a replay, not a journey. This
 * script never creates users and never writes to any table itself.
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

/**
 * A measurement run issues real `POST /org/setup/complete` calls, so it creates organisations.
 * It must never point at anything but an explicitly named disposable environment.
 */
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function readCookies(): string[] {
  const path = required("SETUP_SESSION_COOKIE_FILE");
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    console.error(`${path} contains no cookie lines`);
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

async function postComplete(
  baseUrl: string,
  cookie: string,
  inviteeCount: number,
): Promise<{ orgId: string; elapsedMs: number; startedAt: number }> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/org/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
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
  cookie: string,
  startedAt: number,
): Promise<number | null> {
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const response = await fetch(`${baseUrl}/org/setup/status`, { headers: { cookie } });
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

async function timedGet(baseUrl: string, cookie: string, path: string): Promise<number | null> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
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
    cookies: readonly string[];
  },
  sql: Sql,
): Promise<SpanSample[]> {
  const samples: SpanSample[] = [];
  for (const cookie of options.cookies) {
    const before = await statementCalls(sql);
    const { orgId, elapsedMs, startedAt } = await postComplete(
      options.baseUrl,
      cookie,
      options.inviteeCount,
    );
    const readyMs = await pollUntilReady(options.baseUrl, cookie, startedAt);
    const commitToClaimMs = await waitForDurableClaim(sql, orgId, startedAt);
    const consumerMs = await consumerSpanMs(sql, orgId);
    const usableColdMs = await timedGet(options.baseUrl, cookie, options.usablePath);
    const usableWarmMs = await timedGet(options.baseUrl, cookie, options.usablePath);
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

  const refusals: Array<[TargetRefusal, boolean]> = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "scratch_local", false), true],
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/streamlineos", "scratch_local", false), false],
    [assertDisposableTarget("postgresql://u:p@db.prod.example:5432/scratch_local", "scratch_local", false), false],
    [assertDisposableTarget("postgresql://u:p@db.test.example:5432/scratch_local", "scratch_local", true), true],
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", undefined, false), false],
    [assertDisposableTarget("not-a-url", "scratch_local", false), false],
  ];
  for (const [result, expected] of refusals)
    if (result.allowed !== expected)
      throw new Error(`self-test: refusal mismatch — ${result.reason}`);

  console.log("measure-org-setup-journey self-test passed");
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const namedEnvironment = process.env["SETUP_MEASUREMENT_ENV"];
  const databaseUrl = required("APP_DATABASE_URL");
  const refusal = assertDisposableTarget(
    databaseUrl,
    namedEnvironment,
    process.env["SETUP_ALLOW_REMOTE"] === "1",
  );
  if (!refusal.allowed) {
    console.error(`refusing to measure: ${refusal.reason}`);
    process.exit(1);
  }

  const baseUrl = required("SETUP_API_BASE_URL").replace(/\/$/, "");
  const usablePath = process.env["SETUP_USABLE_PAGE_PATH"] ?? "/me/access";
  const inviteeBatch = Number(process.env["SETUP_INVITEE_BATCH"] ?? 10);
  const cookies = readCookies();
  const half = Math.floor(cookies.length / 2);
  if (half === 0) {
    console.error("at least two cookie lines are required — one scenario each");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    console.log(`target: ${refusal.reason}`);
    console.log(`dataset: ${await describeDataset(sql)}`);
    console.log(`usable-page read: GET ${usablePath}`);

    const noInvitees = await runScenario(
      { baseUrl, usablePath, inviteeCount: 0, cookies: cookies.slice(0, half) },
      sql,
    );
    const withInvitees = await runScenario(
      { baseUrl, usablePath, inviteeCount: inviteeBatch, cookies: cookies.slice(half) },
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
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
