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
import { DB_POOL_CONFIG, DRIZZLE } from "../db/drizzle.constants";
import { type Db } from "../db/drizzle.module";
import { poolTelemetry, type PoolTelemetrySnapshot } from "../db/pool-telemetry";
import type { ResolvedPoolConfig } from "../db/pool.config";
import { Public } from "../common/auth/public.decorator";
import { drainBacklog } from "../common/workflow/workflow-store";

const DRAIN_STALL_SECONDS = 300;
const SCHEDULE_STALL_SECONDS = 300;

const SETTLING_DELAY_MS = Math.max(
  0,
  parseInt(process.env["SHUTDOWN_SETTLING_DELAY_MS"] ?? "5000", 10),
);

interface WorkflowHealth {
  status: "ok" | "stalled";
  due: number;
  oldestDueSeconds: number | null;
  overdueSchedules: number;
  oldestOverdueScheduleSeconds: number | null;
  hint?: string;
}

interface PoolHealth {
  status: "ok" | "saturated";
  latencyMs: number;
  endpoint: { host: string; pooled: boolean; role: ResolvedPoolConfig["role"] };
  pool: PoolTelemetrySnapshot;
}

@Public()
@Controller("health")
export class HealthController implements BeforeApplicationShutdown {
  private isShuttingDown = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(DB_POOL_CONFIG) private readonly poolConfig: ResolvedPoolConfig,
  ) {}

  async beforeApplicationShutdown(_signal?: string): Promise<void> {
    this.isShuttingDown = true;
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLING_DELAY_MS));
  }

  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    if (this.isShuttingDown) throw new ServiceUnavailableException("Shutting down");
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Database is not ready");
    }
  }

  @Get("workflows")
  async workflows(
    @Headers("x-internal-secret") secret: string | undefined,
  ): Promise<WorkflowHealth> {
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || secret !== expected) throw new UnauthorizedException();

    const [backlog, scheduleRows] = await Promise.all([
      drainBacklog(this.db),
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
      ...(hints.length ? { hint: hints.join(" ") } : {}),
    };
  }

  @Get("db")
  async databasePool(
    @Headers("x-internal-secret") secret: string | undefined,
  ): Promise<PoolHealth> {
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || secret !== expected) throw new UnauthorizedException();

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
    };
  }
}
