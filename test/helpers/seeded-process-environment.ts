import { generateKeyPairSync, randomBytes } from "node:crypto";
import { assertDisposableDatabase } from "./disposable-database";

export const seededWorkerFlags = [
  "NOTIFICATIONS_INPROCESS_WORKER", "HR_EXPORT_WORKER_ENABLED", "PAYROLL_EXPORT_WORKER_ENABLED",
  "EXPENSE_EXPORT_WORKER_ENABLED", "FINANCE_REPORT_EXPORT_WORKER_ENABLED", "GDPR_EXPORT_WORKER_ENABLED",
  "KB_CHAT_PURGE_WORKER_ENABLED", "RETENTION_SCHEDULER_ENABLED", "OUTBOX_DISPATCH_ENABLED",
  "OUTBOX_INPROCESS_WORKER",
] as const;

function targetUrl(value: string | undefined, database: string, name: string): URL {
  if (!value) throw new Error(`[seeded-e2e] ${name} is required`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`[seeded-e2e] invalid ${name}`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error(`[seeded-e2e] ${name} must use PostgreSQL`);
  url.pathname = `/${database}`;
  if (url.searchParams.has("options")) throw new Error(`[seeded-e2e] ${name} must not override PostgreSQL session options`);
  return url;
}

export function buildSeededProcessEnvironment(source: NodeJS.ProcessEnv, database: string): NodeJS.ProcessEnv {
  if (!/^scratch_[a-z0-9_]+$/.test(database))
    throw new Error("[seeded-e2e] explicitly name a scratch_<name> database");
  const owner = targetUrl(source.DATABASE_URL, database, "DATABASE_URL");
  const app = targetUrl(source.APP_DATABASE_URL, database, "APP_DATABASE_URL");
  if (owner.username === app.username)
    throw new Error("[seeded-e2e] application and owner roles must be distinct");
  if (owner.hostname.replace("-pooler", "") !== app.hostname.replace("-pooler", ""))
    throw new Error("[seeded-e2e] owner and app must target the same scratch server");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME"])
    if (source[key]) env[key] = source[key];
  for (const key of [
    "SEED_ORG_ID", "SEED_MINORITY_ORG_ID", "ROUTE_BUDGET_HTTP_ARTIFACT", "ROUTE_BUDGET_HTTP_SAMPLES",
    "ROUTE_BUDGET_HTTP_WRITE_SAMPLES", "ROUTE_BUDGET_HTTP_HEAP_SAMPLES", "ROUTE_BUDGET_HTTP_WARMUP",
    "ROUTE_BUDGET_HTTP_DEADLINE_MS", "ROUTE_BUDGET_HTTP_ONLY", "ROUTE_BUDGET_HTTP_SKIP_WRITES",
    "ROUTE_BUDGET_HTTP_REPO", "ROUTE_BUDGET_HTTP_PROVENANCE",
    "BOLA_SOURCE_ORG_ID", "BOLA_PROBER_ORG_ID", "BOLA_PROBER_USER_ID", "BOLA_LIVE_ARTIFACT",
    "BOLA_LIVE_ONLY", "BOLA_LIVE_ONLY_FILE", "BOLA_LIVE_LIMIT", "BOLA_LIVE_MIN_SCORED",
    "BOLA_LIVE_ID_ATTEMPTS", "BOLA_LIVE_TABLE_ATTEMPTS", "BOLA_LIVE_MAX_ATTEMPTS",
    "BOLA_LIVE_SEED_FIXTURES", "BOLA_LIVE_POOL", "BOLA_LIVE_TIMEOUT_MS",
  ])
    if (source[key]) env[key] = source[key];
  const keys = generateKeyPairSync("ed25519");
  Object.assign(env, {
    NODE_ENV: "test", SEEDED_E2E_ISOLATED: "1", SEEDED_E2E_DATABASE: database,
    DATABASE_URL: owner.toString(), APP_DATABASE_URL: app.toString(), DIRECT_DATABASE_URL: owner.toString(),
    PRIMARY_REGION: "primary", REGION_KEYS: "primary", CELL_ID: "legacy-1",
    DB_POOL_MAX: "5", DB_POOL_CONNECT_TIMEOUT: "10", DB_STATEMENT_TIMEOUT_MS: "15000",
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "15000", DB_APPLICATION_NAME: "streamlineos-seeded-e2e",
    REGION_PRIMARY_DATABASE_URL: owner.toString(), REGION_PRIMARY_APP_DATABASE_URL: app.toString(),
    REGION_PRIMARY_CELL_ID: "legacy-1", REQUIRE_ROUTE_CLASSIFICATION: "true",
    CORS_ORIGINS: "http://localhost:3000", APP_URL: "http://localhost:3000",
    BACKEND_JWT_SECRET: randomBytes(48).toString("base64"), PORTAL_JWT_SECRET: randomBytes(48).toString("base64"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    CRON_SECRET: randomBytes(32).toString("hex"),
    AUTH_SIGNING_KEYS: JSON.stringify([{ kid: "seeded-local", privateKey: keys.privateKey.export({ format: "jwk" }), publicKey: keys.publicKey.export({ format: "jwk" }) }]),
    DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
  });
  for (const flag of seededWorkerFlags) env[flag] = "false";
  return env;
}

export function assertSeededProcessIsolation(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "test" || env.SEEDED_E2E_ISOLATED !== "1")
    throw new Error("[seeded-e2e] use test/helpers/run-seeded-e2e.ts; direct seeded execution is refused");
  const database = env.SEEDED_E2E_DATABASE;
  if (!database || !/^scratch_[a-z0-9_]+$/.test(database)) throw new Error("[seeded-e2e] missing scratch target");
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/(DATABASE|REPLICA).*(URL|URI)$/.test(key)) {
      const target = assertDisposableDatabase(value);
      if (!target.ok || target.database !== database) throw new Error(`[seeded-e2e] unsafe database target in ${key}`);
      const candidate = new URL(value);
      const owner = new URL(env.DATABASE_URL ?? "");
      if (candidate.hostname.replace("-pooler", "") !== owner.hostname.replace("-pooler", ""))
        throw new Error(`[seeded-e2e] unexpected database server in ${key}`);
    }
    if (/(API_KEY|ACCESS_KEY|SECRET_ACCESS|REDIS|RAZORPAY|TWILIO|ZEPTOMAIL|VAPID|COMPOSIO|SMTP|SENTRY_DSN|OTEL_EXPORTER)/i.test(key))
      throw new Error(`[seeded-e2e] external integration configuration refused: ${key}`);
  }
  if (!env.APP_DATABASE_URL || !env.DATABASE_URL || new URL(env.APP_DATABASE_URL).username === new URL(env.DATABASE_URL).username)
    throw new Error("[seeded-e2e] a distinct application role is required");
  for (const flag of seededWorkerFlags)
    if (env[flag] !== "false") throw new Error(`[seeded-e2e] background work must be disabled: ${flag}`);
}
