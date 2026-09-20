import { z } from "zod";
import type postgres from "postgres";
import { SEAM_BUDGETS } from "../common/observability/seam-budgets";
import { DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_QUEUE_DEPTH_FACTOR } from "./pool-admission";
import { createRdsIamPasswordProvider, isRdsIamAuthEnabled, rdsRegionFor } from "./rds-iam-auth";

export type PoolOptions = NonNullable<Parameters<typeof postgres>[1]>;

const NEON_HOST = /\.neon\.tech/i;
const POOLED_HOST = /-pooler\./i;
const AWS_RDS_HOST = /\.rds\.amazonaws\.com$/i;
const AURORA_HOST = /\.(?:cluster|cluster-ro)-[a-z0-9-]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/i;

const DEFAULT_APPLICATION_NAME = "streamlineos-api";
const PINNED_TIME_ZONE = "UTC";
const DEFAULT_SLOW_ACQUIRE_MS = SEAM_BUDGETS['db.pool.wait'].thresholdMs;
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5;
const DIRECT_ENDPOINT_SAFE_MAX = 10;

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalInt = (min: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).optional());

const optionalBool = () =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === "") return undefined;
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      return v;
    },
    z.boolean().optional(),
  );

const optionalConnectionUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .superRefine((value, context) => {
      try {
        const parsed = new URL(value);
        if (!["postgres:", "postgresql:"].includes(parsed.protocol))
          context.addIssue({ code: "custom", message: "must use postgres:// or postgresql://" });
        if (!parsed.username || !parsed.hostname || !parsed.pathname || parsed.pathname === "/")
          context.addIssue({ code: "custom", message: "must include a user, host and database name" });
        if (AWS_RDS_HOST.test(parsed.hostname)) {
          const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
          if (!sslMode || !["require", "verify-ca", "verify-full"].includes(sslMode))
            context.addIssue({ code: "custom", message: "AWS RDS/Aurora URLs must enable sslmode" });
        }
      } catch {
        context.addIssue({ code: "custom", message: "must be a valid PostgreSQL URL" });
      }
    })
    .optional(),
);

export const poolEnvShape = {
  DB_POOL_MAX: optionalInt(1),
  DB_POOL_IDLE_TIMEOUT: optionalInt(1),
  DB_POOL_CONNECT_TIMEOUT: optionalInt(1),
  DB_POOL_MAX_LIFETIME: optionalInt(30),
  DB_POOL_SHUTDOWN_TIMEOUT: optionalInt(1),
  DB_STATEMENT_TIMEOUT_MS: optionalInt(0),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: optionalInt(0),
  DB_LOCK_TIMEOUT_MS: optionalInt(0),
  DB_SLOW_ACQUIRE_MS: optionalInt(1),
  DB_POOL_QUEUE_DEPTH: optionalInt(0),
  DB_POOL_ACQUIRE_TIMEOUT_MS: optionalInt(1),
  DB_POOL_ADMISSION_ENABLED: optionalBool(),
  DB_IAM_AUTH: optionalBool(),
  DB_APPLICATION_NAME: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(63).optional(),
  ),
  DB_REPLICA_URL: optionalConnectionUrl,
} as const;

const poolEnvSchema = z.object(poolEnvShape);

export interface TransactionGuards {
  statementTimeoutMs: number;
  idleInTransactionMs: number;
  lockTimeoutMs: number;
}

export interface PoolRuntime {
  utcOffsetMinutes: number;
}

export interface ResolvedPoolConfig {
  guards: TransactionGuards;
  connectionString: string;
  replicaConnectionString?: string;
  role: "application" | "owner";
  host: string;
  isNeon: boolean;
  isAwsRds: boolean;
  isAurora: boolean;
  isPooled: boolean;
  max: number;
  slowAcquireMs: number;
  shutdownTimeoutSeconds: number;
  options: PoolOptions;
  admission: PoolAdmissionTuning;
  warnings: string[];
}

/**
 * postgres-js has no acquire or queue timeout to set, so the bound lives in
 * front of the driver instead (`db/pool-admission.ts`). These are its numbers.
 * `enabled: false` restores the previous behaviour — an unbounded wait — and is
 * a deliberate line in a deployment config, never a default.
 */
export interface PoolAdmissionTuning {
  enabled: boolean;
  queueDepth: number;
  acquireTimeoutMs: number;
}

export function normalizeDatabaseUrl(url: string): string {
  if (!NEON_HOST.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

export function requiresTls(url: string): boolean {
  const host = hostOf(url);
  return NEON_HOST.test(host || url) || AWS_RDS_HOST.test(host);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Builds the per-connection password provider for RDS/Aurora IAM authentication.
 *
 * The connection string carries the user, host and database but no password; the
 * "password" is a short-lived IAM auth token minted from the AWS credential chain on
 * every new connection, so it never expires mid-pool. Fails fast at boot when the URL
 * has no username or the region cannot be resolved, rather than at first connect.
 */
function buildRdsIamPassword(
  connectionString: string,
  host: string,
  env: NodeJS.ProcessEnv,
): () => Promise<string> {
  let username = "";
  let port = 5432;
  try {
    const url = new URL(connectionString);
    username = decodeURIComponent(url.username);
    if (url.port) port = Number(url.port);
  } catch {
    throw new Error("[db-pool] DB_IAM_AUTH is set but the connection string is not a valid URL");
  }
  if (!username)
    throw new Error("[db-pool] DB_IAM_AUTH is set but the connection string has no username");
  const region = rdsRegionFor(host, env);
  if (!region)
    throw new Error(
      "[db-pool] DB_IAM_AUTH is set but no AWS region resolved from the host or AWS_REGION",
    );
  return createRdsIamPasswordProvider({ host, port, username, region });
}

/**
 * Neon's pooler silently drops these as startup parameters and hard-fails
 * `options=-c …` with 08P01, so they are applied per transaction with
 * `set_config(…, is_local => true)` instead — verified against the live endpoint.
 */
export function resolveTransactionGuards(env: NodeJS.ProcessEnv): TransactionGuards {
  const tuning = parsePoolEnv(env);
  return {
    statementTimeoutMs: tuning.DB_STATEMENT_TIMEOUT_MS ?? 30_000,
    idleInTransactionMs: tuning.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 60_000,
    lockTimeoutMs: tuning.DB_LOCK_TIMEOUT_MS ?? 5_000,
  };
}

function parsePoolEnv(env: NodeJS.ProcessEnv): z.infer<typeof poolEnvSchema> {
  const result = poolEnvSchema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`[db-pool] Invalid pool configuration:\n${issues}`);
}

/**
 * 1388 of the schema's timestamp columns are `timestamp without time zone`. The
 * driver writes a JS Date as a `timestamptz` literal and reads a naive column back
 * with a bare `new Date(text)`, so the value only survives the round trip while the
 * session's TimeZone and the process's TZ agree. Measured against PostgreSQL 18.4:
 * with the session on `Asia/Kolkata` and the process on UTC, `2026-09-02T12:00:00Z`
 * reads back as `17:30:00Z`; pinning the session to UTC while the process stays on
 * `Asia/Kolkata` shifts it the other way, to `06:30:00Z`. Pinning the session is
 * therefore only half the fix — the image sets `TZ=UTC` for the other half, and a
 * process running anywhere else gets told below.
 */
export function describeTimezoneRisk(utcOffsetMinutes: number): string | null {
  if (utcOffsetMinutes === 0) return null;
  const hours = -utcOffsetMinutes / 60;
  return `The database session is pinned to ${PINNED_TIME_ZONE} but this process runs at UTC${hours >= 0 ? "+" : ""}${hours}. Every \`timestamp without time zone\` column will read back shifted by ${hours} hours. Set TZ=UTC on the process (the container image already does).`;
}

const DEFAULT_POOL_MAX = 20;
const DEVELOPMENT_POOL_MAX = 5;
const CONSTRAINED_ENDPOINT_POOL_MAX = 10;

export function resolvePoolMax(env: NodeJS.ProcessEnv): number {
  const tuning = parsePoolEnv(env);
  if (tuning.DB_POOL_MAX !== undefined) return tuning.DB_POOL_MAX;
  if (env.NODE_ENV === "development") return DEVELOPMENT_POOL_MAX;

  const raw = env.APP_DATABASE_URL || env.DATABASE_URL;
  if (!raw) return DEFAULT_POOL_MAX;

  const connectionString = normalizeDatabaseUrl(raw);
  const host = hostOf(connectionString);
  const probe = host || connectionString;
  if (POOLED_HOST.test(probe)) return DEFAULT_POOL_MAX;
  if (NEON_HOST.test(probe) || AWS_RDS_HOST.test(host)) return CONSTRAINED_ENDPOINT_POOL_MAX;
  return DEFAULT_POOL_MAX;
}

/**
 * Defaults differ by endpoint because the constraints do: a Neon compute suspends
 * when idle and caps `max_connections` low on a direct endpoint, while its
 * transaction-mode pooler multiplexes many clients onto few server connections
 * but cannot serve prepared statements.
 */
export function resolvePoolConfig(
  env: NodeJS.ProcessEnv,
  runtime: PoolRuntime = { utcOffsetMinutes: new Date().getTimezoneOffset() },
): ResolvedPoolConfig {
  const raw = env.APP_DATABASE_URL || env.DATABASE_URL;
  if (!raw)
    throw new Error("[db-pool] APP_DATABASE_URL or DATABASE_URL is required");

  const tuning = parsePoolEnv(env);
  const connectionString = normalizeDatabaseUrl(raw);
  const host = hostOf(connectionString);
  const probe = host || connectionString;
  const isNeon = NEON_HOST.test(probe);
  const isAwsRds = AWS_RDS_HOST.test(host);
  const isAurora = AURORA_HOST.test(host);
  const isPooled = POOLED_HOST.test(probe);
  const isProduction = env.NODE_ENV === "production";
  const isDevelopment = env.NODE_ENV === "development";

  const max = resolvePoolMax(env);
  const idleTimeout =
    tuning.DB_POOL_IDLE_TIMEOUT ?? (isNeon || isAwsRds ? 15 : isDevelopment ? 20 : 60);
  // Aurora Serverless can take longer to accept a connection while resuming from
  // zero ACUs. Keep the connect budget generous and release idle clients quickly
  // enough that this process doesn't prevent an otherwise-idle cluster pausing.
  const connectTimeout = tuning.DB_POOL_CONNECT_TIMEOUT ?? (isNeon || isAwsRds ? 30 : 15);
  const maxLifetime =
    tuning.DB_POOL_MAX_LIFETIME ?? (isNeon ? 60 * 4 : isAwsRds ? 60 * 15 : 60 * 30);
  const guards = resolveTransactionGuards(env);

  const connection: NonNullable<PoolOptions["connection"]> = {
    application_name: tuning.DB_APPLICATION_NAME ?? DEFAULT_APPLICATION_NAME,
    TimeZone: PINNED_TIME_ZONE,
  };

  const iamPassword =
    isRdsIamAuthEnabled(env) && isAwsRds
      ? buildRdsIamPassword(connectionString, host, env)
      : undefined;

  const options: PoolOptions = {
    max,
    prepare: false,
    idle_timeout: idleTimeout,
    connect_timeout: connectTimeout,
    max_lifetime: maxLifetime,
    connection,
    ...(requiresTls(connectionString) ? { ssl: "require" as const } : {}),
    ...(iamPassword ? { password: iamPassword } : {}),
  };

  const replicaRaw = tuning.DB_REPLICA_URL;

  return {
    max,
    host,
    guards,
    isNeon,
    isAwsRds,
    isAurora,
    options,
    isPooled,
    connectionString,
    replicaConnectionString: replicaRaw ? normalizeDatabaseUrl(replicaRaw) : undefined,
    warnings: collectWarnings({
      max,
      isNeon,
      isAwsRds,
      isAurora,
      isPooled,
      isProduction,
      guards,
      utcOffsetMinutes: runtime.utcOffsetMinutes,
    }),
    admission: {
      enabled: tuning.DB_POOL_ADMISSION_ENABLED ?? true,
      queueDepth: tuning.DB_POOL_QUEUE_DEPTH ?? max * DEFAULT_QUEUE_DEPTH_FACTOR,
      acquireTimeoutMs: tuning.DB_POOL_ACQUIRE_TIMEOUT_MS ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    },
    role: env.APP_DATABASE_URL ? "application" : "owner",
    slowAcquireMs: tuning.DB_SLOW_ACQUIRE_MS ?? DEFAULT_SLOW_ACQUIRE_MS,
    shutdownTimeoutSeconds:
      tuning.DB_POOL_SHUTDOWN_TIMEOUT ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
  };
}

function collectWarnings(input: {
  isProduction: boolean;
  isNeon: boolean;
  isAwsRds: boolean;
  isAurora: boolean;
  isPooled: boolean;
  max: number;
  guards: TransactionGuards;
  utcOffsetMinutes: number;
}): string[] {
  const warnings: string[] = [];
  const { statementTimeoutMs, idleInTransactionMs } = input.guards;

  const timezoneRisk = describeTimezoneRisk(input.utcOffsetMinutes);
  if (timezoneRisk) warnings.push(timezoneRisk);

  if (input.isNeon && !input.isPooled && input.max > DIRECT_ENDPOINT_SAFE_MAX)
    warnings.push(
      `DB_POOL_MAX=${input.max} on a direct Neon endpoint: max_connections there is small and shared with migrations and scripts, so every extra instance multiplies the risk of exhaustion. Use the -pooler host or lower DB_POOL_MAX to ${DIRECT_ENDPOINT_SAFE_MAX}.`,
    );

  if (input.isAwsRds && input.max > 20)
    warnings.push(
      `DB_POOL_MAX=${input.max} on an AWS RDS endpoint. Every backend replica owns its own pool, so total possible connections are DB_POOL_MAX multiplied by the replica count. Keep it at 10 initially and raise it only from measured saturation data.`,
    );

  if (input.isAurora && input.isProduction && input.max > 10)
    warnings.push(
      "Aurora Serverless is configured above the conservative 10-connection application default; verify the cluster's minimum ACUs and total backend replica count before deploying.",
    );

  if (statementTimeoutMs === 0 && input.isProduction)
    warnings.push(
      "statement_timeout is disabled: one runaway query can hold a pooled connection until the process restarts.",
    );

  if (idleInTransactionMs === 0 && input.isProduction)
    warnings.push(
      "idle_in_transaction_session_timeout is disabled: every request runs inside a tenant transaction, so a handler stalled on an external call pins its connection indefinitely.",
    );

  if (
    idleInTransactionMs > 0 &&
    statementTimeoutMs > 0 &&
    idleInTransactionMs < statementTimeoutMs
  )
    warnings.push(
      `idle_in_transaction_session_timeout (${idleInTransactionMs}ms) is below statement_timeout (${statementTimeoutMs}ms), so a legitimately long query can be killed for its caller's idleness.`,
    );

  return warnings;
}
