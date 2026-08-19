import {
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

interface PoolHealth {
  status: "ok" | "saturated";
  latencyMs: number;
  endpoint: { host: string; pooled: boolean; role: ResolvedPoolConfig["role"] };
  pool: PoolTelemetrySnapshot;
}

@Public()
@Controller("health")
export class HealthController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(DB_POOL_CONFIG) private readonly poolConfig: ResolvedPoolConfig,
  ) {}

  @Get()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Database is not ready");
    }
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
