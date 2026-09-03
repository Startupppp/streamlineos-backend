import {
  BeforeApplicationShutdown,
  Controller,
  Get,
  Headers,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Redis } from "@upstash/redis";
import { DB_POOL_CONFIG, DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { poolTelemetry, type PoolTelemetrySnapshot } from "../db/pool-telemetry";
import {
  queryTelemetry,
  type QueryFingerprintStat,
  type QueryTelemetrySnapshot,
} from "../db/query-telemetry";
import type { ResolvedPoolConfig } from "../db/pool.config";
import { Public } from "../common/auth/public.decorator";
import { CacheService, REDIS } from "../common/cache/cache.service";
import { openProvidersAcrossBreakers } from "../common/outbound/provider-circuit-breaker";
import { logger } from "../common/logger/logger.service";
import { cacheCheck, databaseCheck, providerCheck, queueCheck } from "./dependency-checks";
import { resolveReadinessConfig, type ReadinessConfig } from "./readiness.config";
import { ReadinessService } from "./readiness.service";
import type { ReadinessSnapshot } from "./readiness.types";
import { shutdownState } from "./shutdown-state";
import { aggregateWorkflowBacklog } from "./workflow-backlog";

const DRAIN_STALL_SECONDS = 300;
const SCHEDULE_STALL_SECONDS = 300;

interface WorkflowHealth {
  status: "ok" | "stalled";
  due: number;
  oldestDueSeconds: number | null;
  overdueSchedules: number;
  oldestOverdueScheduleSeconds: number | null;
  leased: number;
  retrying: number;
  deadLettered: number;
  cancelled: number;
  organizations: number;
  failedOrganizations: number;
  hint?: string;
}

interface PoolHealth {
  status: "ok" | "saturated";
  latencyMs: number;
  endpoint: { host: string; pooled: boolean; role: ResolvedPoolConfig["role"] };
  pool: PoolTelemetrySnapshot;
  queries: QueryTelemetrySnapshot;
  slowestFingerprints: QueryFingerprintStat[];
}

@Public()
@Controller("health")
export class HealthController implements BeforeApplicationShutdown {
  private readonly config: ReadinessConfig = resolveReadinessConfig();
  private readonly readiness: ReadinessService;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(DB_POOL_CONFIG) private readonly poolConfig: ResolvedPoolConfig,
    @Inject(REDIS) redis: Redis | null,
    private readonly cache: CacheService,
  ) {
    this.readiness = new ReadinessService(
      [
        databaseCheck(() => this.db.execute(sql`select 1`)),
        cacheCheck(redis, () => this.cache.droppedInvalidationCount),
        queueCheck(redis, this.config.queueHeartbeatJobs, this.config.queueStallSeconds, () =>
          Date.now(),
        ),
        /**
         * The PROCESS-level view, not `sharedProviderBreaker`.
         *
         * `sharedProviderBreaker` is only `callProvider`'s default argument and
         * every production call site overrides it with a private instance, so
         * this check read a permanently empty map: it could not report a
         * provider down, and an operator who set
         * `READINESS_REQUIRED_PROVIDERS` got a check that renders and never
         * denies. `openProvidersAcrossBreakers` aggregates every breaker in the
         * process, so a breaker added later is covered with no wiring here.
         */
        providerCheck(
          this.config.requiredProviders,
          (now) => openProvidersAcrossBreakers(now),
          () => Date.now(),
        ),
      ],
      this.config,
    );
  }

  /**
   * Fails readiness first, then stops accepting, then waits for in-flight work.
   *
   * The settling delay is the window the load balancer needs to observe the 503
   * and take this replica out of rotation; refusing requests before it has is how
   * a rolling deploy drops traffic. Only once nothing new can arrive is waiting
   * for quiescence meaningful — and it happens here, in `beforeApplicationShutdown`,
   * because `DrizzleModule.onApplicationShutdown` ends the connection pool and
   * Nest does not run that until every hook at this stage has resolved.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    shutdownState.beginDrain();
    this.readiness.invalidate();
    await delay(this.config.settlingDelayMs);

    shutdownState.stopAccepting();
    const { drained, remaining } = await shutdownState.awaitQuiescence(this.config.drainTimeoutMs);
    if (drained) {
      logger.info("Shutdown drain complete — no requests in flight", { signal: signal ?? null });
      return;
    }
    logger.warn("Shutdown drain timed out with requests still in flight", {
      signal: signal ?? null,
      remaining,
      drainTimeoutMs: this.config.drainTimeoutMs,
    });
  }

  /**
   * Liveness. Deliberately shallow: it touches no dependency, because a probe
   * that fails on a database blip gets the process killed instead of drained,
   * and restarting a replica cannot fix a shared dependency.
   */
  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<ReadinessSnapshot> {
    if (shutdownState.isDraining())
      throw new ServiceUnavailableException("Shutting down — no longer accepting new work");

    const snapshot = await this.readiness.read();
    if (snapshot.status === "unready")
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: "Service Unavailable",
        message: "One or more required dependencies are unavailable",
        readiness: snapshot,
      });
    return snapshot;
  }

  @Get("workflows")
  async workflows(
    @Headers("x-internal-secret") secret: string | undefined,
  ): Promise<WorkflowHealth> {
    assertInternalSecret(secret);

    const [backlog, scheduleRows] = await Promise.all([
      aggregateWorkflowBacklog(this.db),
      this.db.execute(sql`
        SELECT count(*)::int AS overdue,
               COALESCE(EXTRACT(EPOCH FROM (now() - min(next_run_at)))::int, 0) AS oldest
        FROM workflow_schedules
        WHERE is_enabled = true AND next_run_at IS NOT NULL AND next_run_at <= now()
      `),
    ]);

    const scheduleRow = ([...scheduleRows][0] ?? {}) as Record<string, unknown>;
    const overdueSchedules = Number(scheduleRow.overdue ?? 0);
    const oldestOverdueScheduleSeconds =
      overdueSchedules > 0 ? Number(scheduleRow.oldest ?? 0) : null;

    const drainStalled =
      backlog.oldestDueSeconds !== null && backlog.oldestDueSeconds > DRAIN_STALL_SECONDS;
    const schedulesStalled =
      oldestOverdueScheduleSeconds !== null &&
      oldestOverdueScheduleSeconds > SCHEDULE_STALL_SECONDS;

    const hints: string[] = [];
    if (drainStalled)
      hints.push(
        "Nothing is calling GET|POST /cron/workflow-tick. Schedule it at least every minute with the cron secret.",
      );
    if (schedulesStalled)
      hints.push(
        "Nothing is calling POST /cron/workflow-schedules-tick. Schedule it at least every minute with the cron secret, or scheduled workflows never fire.",
      );

    return {
      status: drainStalled || schedulesStalled ? "stalled" : "ok",
      due: backlog.due,
      oldestDueSeconds: backlog.oldestDueSeconds,
      overdueSchedules,
      oldestOverdueScheduleSeconds,
      leased: backlog.leased,
      retrying: backlog.retrying,
      deadLettered: backlog.deadLettered,
      cancelled: backlog.cancelled,
      organizations: backlog.organizations,
      failedOrganizations: backlog.failedOrganizations,
      ...(hints.length ? { hint: hints.join(" ") } : {}),
    };
  }

  @Get("db")
  async databasePool(
    @Headers("x-internal-secret") secret: string | undefined,
  ): Promise<PoolHealth> {
    assertInternalSecret(secret);

    const startedAt = Date.now();
    await this.db.execute(sql`select 1`);
    const pool = poolTelemetry.snapshot();

    return {
      status: pool.waiting > 0 ? "saturated" : "ok",
      latencyMs: Date.now() - startedAt,
      endpoint: {
        host: this.poolConfig.host,
        pooled: this.poolConfig.isPooled,
        role: this.poolConfig.role,
      },
      pool,
      queries: queryTelemetry.snapshot(),
      /*
       * Shapes only. `fingerprintQuery` normalises every literal and `$n`
       * placeholder to `?` before a shape is ever stored, so this endpoint
       * cannot disclose a bind value even though it is the slow-query view.
       */
      slowestFingerprints: queryTelemetry.topFingerprints(),
    };
  }
}

function assertInternalSecret(secret: string | undefined): void {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || secret !== expected) throw new UnauthorizedException();
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
