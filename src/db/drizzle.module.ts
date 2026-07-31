import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createTenantAwareDb } from "../common/tenant/tenant-db";
import { DRIZZLE } from "./drizzle.constants";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

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
export class DrizzleModule implements OnApplicationShutdown {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db & { __client: ReturnType<typeof postgres> },
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.__client.end({ timeout: 5 });
  }
}
