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
import { createTenantAwareDb } from "../common/tenant/tenant-db";
import type { Db } from "./drizzle.types";
import { DRIZZLE } from "./drizzle.constants";
import * as schema from "./schema";

export type { Db } from "./drizzle.types";

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: (): Db & { __client: ReturnType<typeof postgres> } => {
        // APP_DATABASE_URL is the non-owner, non-BYPASSRLS role. Unsetting it rolls RLS back instantly.
        const raw = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
        if (!raw) throw new Error("DATABASE_URL is required");
        if (process.env.APP_DATABASE_URL) {
          new Logger("Drizzle").log("Connecting as the RLS-enforced application role");
        }
        const connectionString = normalizeDatabaseUrl(raw);
        const isNeon = /\.neon\.tech/i.test(connectionString);
        const isDev = process.env.NODE_ENV === "development";
        const client = postgres(connectionString, {
          prepare: false,
          max: isDev ? 5 : 20,
          idle_timeout: isNeon ? 15 : (isDev ? 20 : 60),
          connect_timeout: isNeon ? 30 : 15,
          max_lifetime: isNeon ? 60 * 4 : 60 * 30,
          ...(isNeon ? { ssl: "require" as const } : {}),
        });
        const db = Object.assign(drizzle(client, { schema }) as Db, { __client: client });
        return createTenantAwareDb(db) as Db & { __client: ReturnType<typeof postgres> };
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Drizzle");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db & { __client: ReturnType<typeof postgres> },
  ) {}

  /**
   * Refuses to serve traffic with RLS silently disabled.
   *
   * Policies are enforced against the connecting role, and BYPASSRLS is checked
   * before ownership — so a typo in APP_DATABASE_URL falls back to the owner and
   * every policy stops applying, with nothing in the logs to say so. That is the
   * one failure mode of this design that is invisible, so it fails loudly.
   */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db.execute(sql`
      SELECT current_user AS role_name,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
        EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relrowsecurity
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
    await this.db.__client.end({ timeout: 5 });
  }
}
