import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

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

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL is required");

const client = postgres(normalizeDatabaseUrl(raw), {
  prepare: false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 30,
});

export const db = drizzle(client, { schema });
