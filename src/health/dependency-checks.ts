import { HEARTBEAT_KEY_PREFIX } from "../modules/cron/cron-lease.service";
import type { DependencyCheck, DependencyOutcome, ReadinessRedis } from "./readiness.types";

export const DATABASE_CHECK = "database";
export const CACHE_CHECK = "cache";
export const QUEUE_CHECK = "queue";
export const PROVIDER_CHECK = "providers";

/**
 * The database is the only hard dependency: without it no request can be
 * authorised, let alone served, so its failure is unready rather than degraded.
 */
export function databaseCheck(probe: () => Promise<unknown>): DependencyCheck {
  return {
    name: DATABASE_CHECK,
    required: true,
    async run(): Promise<DependencyOutcome> {
      await probe();
      return { state: "up" };
    },
  };
}

/**
 * Cache failure degrades rather than unreadies: a missed read falls through to
 * the database and is still correct. A dropped invalidation is the failure that
 * matters, because it leaves stale entries serving, so it is reported even when
 * the connection itself is healthy.
 */
export function cacheCheck(
  redis: ReadinessRedis | null,
  droppedInvalidations: () => number,
): DependencyCheck {
  return {
    name: CACHE_CHECK,
    required: false,
    async run(): Promise<DependencyOutcome> {
      if (!redis) return { state: "skipped", detail: "Redis is not configured" };
      try {
        await redis.ping();
      } catch (error: unknown) {
        return { state: "degraded", detail: describe(error) };
      }
      const dropped = droppedInvalidations();
      if (dropped > 0)
        return {
          state: "degraded",
          detail: `${String(dropped)} invalidation(s) dropped since boot — stale entries may be serving`,
        };
      return { state: "up" };
    },
  };
}

/**
 * Queue liveness is read from the workers' dead-man heartbeat, not from a
 * backlog query.
 *
 * A backlog count is a cross-tenant read on an RLS table and costs a database
 * round trip per probe; the heartbeat answers the question that actually
 * matters — is anything draining — from a key the lease already writes.
 */
export function queueCheck(
  redis: ReadinessRedis | null,
  jobs: readonly string[],
  stallSeconds: number,
  now: () => number,
): DependencyCheck {
  return {
    name: QUEUE_CHECK,
    required: false,
    async run(): Promise<DependencyOutcome> {
      if (!redis) return { state: "skipped", detail: "Redis is not configured" };
      if (jobs.length === 0) return { state: "skipped", detail: "no drain jobs declared" };

      const stale: string[] = [];
      for (const job of jobs) {
        const raw = await redis.get(`${HEARTBEAT_KEY_PREFIX}${job}`);
        const ageSeconds = heartbeatAgeSeconds(raw, now());
        if (ageSeconds === null) {
          stale.push(`${job} (never ran)`);
          continue;
        }
        if (ageSeconds > stallSeconds) stale.push(`${job} (${String(ageSeconds)}s ago)`);
      }

      if (stale.length === 0) return { state: "up" };
      return {
        state: "degraded",
        detail: `drain heartbeat stale beyond ${String(stallSeconds)}s: ${stale.join(", ")}`,
      };
    },
  };
}

/**
 * Separators between a provider and the operation it names. Descriptor keys are
 * hierarchical — `razorpay-orders`, `webhook:412` — while
 * `READINESS_REQUIRED_PROVIDERS` is set by an operator who writes the product
 * name. Requiring `razorpay` therefore never matched the only key the adapter
 * registers, so even a correctly-fed breaker would have reported `up` through a
 * total outage.
 */
const PROVIDER_KEY_SEPARATORS = ["-", ":", "."];

/**
 * Does `key` name an operation of `required`?
 *
 * Exact match, or `required` followed by a separator — so `razorpay` covers
 * `razorpay-orders` and `webhook` covers `webhook:412`, while `razorpayment`
 * (a different provider that merely shares a prefix) is not covered.
 */
function coversProvider(required: string, key: string): boolean {
  if (key === required) return true;
  if (!key.startsWith(required)) return false;
  return PROVIDER_KEY_SEPARATORS.includes(key.charAt(required.length));
}

/**
 * Providers are read from the in-process circuit breaker rather than called.
 *
 * Calling a provider from a readiness probe is exactly the amplification this
 * endpoint must not do — the breaker already holds the verdict the outbound path
 * paid for.
 */
export function providerCheck(
  required: readonly string[],
  openProviders: (now: number) => readonly string[],
  now: () => number,
): DependencyCheck {
  return {
    name: PROVIDER_CHECK,
    required: true,
    run(): Promise<DependencyOutcome> {
      if (required.length === 0)
        return Promise.resolve({ state: "skipped", detail: "no required providers declared" });

      const open = openProviders(now());
      const failing = required.filter((provider) => open.some((key) => coversProvider(provider, key)));
      if (failing.length === 0) return Promise.resolve({ state: "up" });
      return Promise.resolve({
        state: "down",
        detail: `circuit open for required provider(s): ${failing.join(", ")}`,
      });
    },
  };
}

function heartbeatAgeSeconds(raw: unknown, now: number): number | null {
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 1000));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
