import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalInt = (min: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).optional());

const optionalList = () =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((raw) =>
        raw === undefined
          ? undefined
          : raw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
      ),
  );

export const readinessEnvShape = {
  READINESS_CACHE_TTL_MS: optionalInt(0),
  READINESS_CHECK_TIMEOUT_MS: optionalInt(1),
  READINESS_QUEUE_STALL_SECONDS: optionalInt(1),
  READINESS_QUEUE_HEARTBEAT_JOBS: optionalList(),
  READINESS_REQUIRED_PROVIDERS: optionalList(),
  SHUTDOWN_SETTLING_DELAY_MS: optionalInt(0),
  SHUTDOWN_DRAIN_TIMEOUT_MS: optionalInt(0),
} as const;

const readinessEnvSchema = z.object(readinessEnvShape);

export interface ReadinessConfig {
  readonly cacheTtlMs: number;
  readonly checkTimeoutMs: number;
  readonly queueStallSeconds: number;
  readonly queueHeartbeatJobs: readonly string[];
  readonly requiredProviders: readonly string[];
  readonly settlingDelayMs: number;
  readonly drainTimeoutMs: number;
}

/**
 * Defaults chosen so a probe cannot amplify the outage it reports.
 *
 * `cacheTtlMs` bounds dependency fanout to one evaluation per window no matter
 * how fast probes arrive; `checkTimeoutMs` bounds each individual check so a
 * hung dependency never holds an event-loop slot open for the probe's caller.
 */
export function resolveReadinessConfig(env: NodeJS.ProcessEnv = process.env): ReadinessConfig {
  const result = readinessEnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`[readiness] Invalid readiness configuration:\n${issues}`);
  }
  const parsed = result.data;
  return {
    cacheTtlMs: parsed.READINESS_CACHE_TTL_MS ?? 5_000,
    checkTimeoutMs: parsed.READINESS_CHECK_TIMEOUT_MS ?? 2_000,
    queueStallSeconds: parsed.READINESS_QUEUE_STALL_SECONDS ?? 900,
    queueHeartbeatJobs: parsed.READINESS_QUEUE_HEARTBEAT_JOBS ?? ["outbox-events-worker"],
    requiredProviders: parsed.READINESS_REQUIRED_PROVIDERS ?? [],
    settlingDelayMs: parsed.SHUTDOWN_SETTLING_DELAY_MS ?? 5_000,
    drainTimeoutMs: parsed.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 25_000,
  };
}
