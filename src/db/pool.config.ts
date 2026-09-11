import { z } from "zod";
import type postgres from "postgres";
import { SEAM_BUDGETS } from "../common/observability/seam-budgets";

export type PoolOptions = NonNullable<Parameters<typeof postgres>[1]>;

const NEON_HOST = /\.neon\.tech/i;
const POOLED_HOST = /-pooler\./i;

const DEFAULT_APPLICATION_NAME = "streamlineos-api";
const DEFAULT_SLOW_ACQUIRE_MS = SEAM_BUDGETS['db.pool.wait'].thresholdMs;
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5;
const DIRECT_ENDPOINT_SAFE_MAX = 10;

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalInt = (min: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).optional());

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
  DB_APPLICATION_NAME: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(63).optional(),
  ),
  DB_REPLICA_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
} as const;

const poolEnvSchema = z.object(poolEnvShape);

export interface TransactionGuards {
  statementTimeoutMs: number;
  idleInTransactionMs: number;
  lockTimeoutMs: number;
}

export interface ResolvedPoolConfig {
  guards: TransactionGuards;
  connectionString: string;
  replicaConnectionString?: string;
  role: "application" | "owner";
  host: string;
  isNeon: boolean;
  isPooled: boolean;
  max: number;
  slowAcquireMs: number;
  shutdownTimeoutSeconds: number;
  options: PoolOptions;
  warnings: string[];
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
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
 * Defaults differ by endpoint because the constraints do: a Neon compute suspends
 * when idle and caps `max_connections` low on a direct endpoint, while its
 * transaction-mode pooler multiplexes many clients onto few server connections
 * but cannot serve prepared statements.
 */
/**
 * Whether a connection to `url` has to negotiate TLS.
 *
 * This is the rule `resolvePoolConfig` already applies, exported so that the
 * specs which build their own client can ask it rather than restate it. They
 * used to hard-code `ssl: "require"`, which is correct for Neon and fatal
 * against a local PostgreSQL: the server closes the socket during the
 * handshake, and every case in the file then fails with "Client network socket
 * disconnected before secure TLS connection was established" — a connection
 * failure wearing the costume of a test failure.
 */
export function requiresTls(url: string): boolean {
  return NEON_HOST.test(hostOf(url) || url);
}

export function resolvePoolConfig(env: NodeJS.ProcessEnv): ResolvedPoolConfig {
  const raw = env.APP_DATABASE_URL || env.DATABASE_URL;
  if (!raw)
    throw new Error("[db-pool] APP_DATABASE_URL or DATABASE_URL is required");

  const tuning = parsePoolEnv(env);
  const connectionString = normalizeDatabaseUrl(raw);
  const host = hostOf(connectionString);
  const probe = host || connectionString;
  const isNeon = NEON_HOST.test(probe);
  const isPooled = POOLED_HOST.test(probe);
  const isProduction = env.NODE_ENV === "production";
  const isDevelopment = env.NODE_ENV === "development";

  const max =
    tuning.DB_POOL_MAX ?? (isDevelopment ? 5 : isPooled || !isNeon ? 20 : 10);
  const idleTimeout =
    tuning.DB_POOL_IDLE_TIMEOUT ?? (isNeon ? 15 : isDevelopment ? 20 : 60);
  const connectTimeout = tuning.DB_POOL_CONNECT_TIMEOUT ?? (isNeon ? 30 : 15);
  const maxLifetime =
    tuning.DB_POOL_MAX_LIFETIME ?? (isNeon ? 60 * 4 : 60 * 30);
  const guards = resolveTransactionGuards(env);

  const connection: NonNullable<PoolOptions["connection"]> = {
    application_name: tuning.DB_APPLICATION_NAME ?? DEFAULT_APPLICATION_NAME,
  };

  const options: PoolOptions = {
    max,
    prepare: false,
    idle_timeout: idleTimeout,
    connect_timeout: connectTimeout,
    max_lifetime: maxLifetime,
    connection,
    ...(isNeon ? { ssl: "require" as const } : {}),
  };

  const replicaRaw = tuning.DB_REPLICA_URL;

  return {
    max,
    host,
    guards,
    isNeon,
    options,
    isPooled,
    connectionString,
    replicaConnectionString: replicaRaw ? normalizeDatabaseUrl(replicaRaw) : undefined,
    warnings: collectWarnings({ max, isNeon, isPooled, isProduction, guards }),
    role: env.APP_DATABASE_URL ? "application" : "owner",
    slowAcquireMs: tuning.DB_SLOW_ACQUIRE_MS ?? DEFAULT_SLOW_ACQUIRE_MS,
    shutdownTimeoutSeconds:
      tuning.DB_POOL_SHUTDOWN_TIMEOUT ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
  };
}

function collectWarnings(input: {
  isProduction: boolean;
  isNeon: boolean;
  isPooled: boolean;
  max: number;
  guards: TransactionGuards;
}): string[] {
  const warnings: string[] = [];
  const { statementTimeoutMs, idleInTransactionMs } = input.guards;

  if (input.isNeon && !input.isPooled && input.max > DIRECT_ENDPOINT_SAFE_MAX)
    warnings.push(
      `DB_POOL_MAX=${input.max} on a direct Neon endpoint: max_connections there is small and shared with migrations and scripts, so every extra instance multiplies the risk of exhaustion. Use the -pooler host or lower DB_POOL_MAX to ${DIRECT_ENDPOINT_SAFE_MAX}.`,
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
