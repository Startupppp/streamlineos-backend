import { Global, Module, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
        const raw = process.env.DATABASE_URL;
        if (!raw) throw new Error("DATABASE_URL is required");
        const connectionString = normalizeDatabaseUrl(raw);
        const isNeon = /\.neon\.tech/i.test(connectionString);
        const isDev = process.env.NODE_ENV === "development";
        const client = postgres(connectionString, {
          prepare: false,
          max: isDev ? 10 : 75,
          idle_timeout: isDev ? 20 : 60,
          connect_timeout: isNeon ? 60 : 30,
          max_lifetime: 60 * 30,
          ...(isNeon ? { ssl: "require" as const } : {}),
        });
        const db = drizzle(client, { schema }) as Db;
        return Object.assign(db, { __client: client });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {}
}
