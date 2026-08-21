import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createTenantAwareDb, type DbWithClient } from "../common/tenant/tenant-db";
import { DB_POOL_CONFIG, DRIZZLE } from "./drizzle.constants";
import { poolTelemetry } from "./pool-telemetry";
import { resolvePoolConfig, type ResolvedPoolConfig } from "./pool.config";
import * as schema from "./schema";

export type { Db } from "./drizzle.types";

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL_CONFIG,
      useFactory: (): ResolvedPoolConfig => resolvePoolConfig(process.env),
    },
    {
      provide: DRIZZLE,
      inject: [DB_POOL_CONFIG],
      useFactory: (config: ResolvedPoolConfig): DbWithClient => {
        poolTelemetry.configure({ max: config.max, slowAcquireMs: config.slowAcquireMs });
        const client = postgres(config.connectionString, config.options);
        return createTenantAwareDb(Object.assign(drizzle(client, { schema }), { __client: client }));
      },
    },
  ],
  exports: [DRIZZLE, DB_POOL_CONFIG],
})
export class DrizzleModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Drizzle");

  constructor(
    @Inject(DRIZZLE) private readonly db: DbWithClient,
    @Inject(DB_POOL_CONFIG) private readonly config: ResolvedPoolConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.reportPool();
    await this.assertRlsIsEnforced();
  }

  private reportPool(): void {
    const config = this.config;
    const options = config.options;
    this.logger.log(
      `Pool ready — ${config.max} connections to ${config.host || "configured host"} as the ${config.role} role` +
        `${config.isPooled ? " via a transaction-mode pooler" : ""}`,
    );
    const guard = (ms: number) => (ms > 0 ? `${String(ms)}ms` : "off");
    this.logger.log(
      `Pool limits — idle ${String(options.idle_timeout)}s · connect ${String(options.connect_timeout)}s · ` +
        `lifetime ${String(options.max_lifetime)}s · drain ${String(config.shutdownTimeoutSeconds)}s`,
    );
    this.logger.log(
      `Transaction guards — statement ${guard(config.guards.statementTimeoutMs)} · ` +
        `idle-in-transaction ${guard(config.guards.idleInTransactionMs)} · ` +
        `lock ${guard(config.guards.lockTimeoutMs)}`,
    );
    for (const warning of config.warnings) this.logger.warn(warning);
  }

  /**
   * Refuses to serve traffic with RLS silently disabled.
   *
   * Policies are enforced against the connecting role, and BYPASSRLS is checked
   * before ownership — so a typo in APP_DATABASE_URL falls back to the owner and
   * every policy stops applying, with nothing in the logs to say so. That is the
   * one failure mode of this design that is invisible, so it fails loudly.
   */
  private async assertRlsIsEnforced(): Promise<void> {
    const rows = await this.db.execute(sql`
      SELECT current_user AS role_name,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
        EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'build', 'build_events') AND c.relrowsecurity
        ) AS policies_exist
    `);

    const row: Record<string, unknown> | undefined = rows[0];
    if (!row) return;

    const roleName = String(row.role_name ?? "unknown");
    const bypassesRls = row.bypasses_rls === true;
    const policiesExist = row.policies_exist === true;

    if (!policiesExist) {
      this.logger.warn(`No RLS policies found; tenant isolation rests on application code alone`);
      return;
    }

    if (!bypassesRls) {
      this.logger.log(`RLS enforced — connected as "${roleName}"`);
      return;
    }

    const message =
      `RLS is enabled but "${roleName}" has BYPASSRLS, so every tenant policy is inert. ` +
      `Set APP_DATABASE_URL to the non-owner application role.`;

    if (process.env.NODE_ENV === "production") throw new Error(message);
    this.logger.error(message);
  }

  async onApplicationShutdown(): Promise<void> {
    const { inFlight, waiting } = poolTelemetry.snapshot();
    if (inFlight > 0 || waiting > 0)
      this.logger.log(`Draining pool — ${inFlight} in flight, ${waiting} queued`);
    await this.db.__client.end({ timeout: this.config.shutdownTimeoutSeconds });
  }
}
