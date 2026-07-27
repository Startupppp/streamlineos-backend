import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { users } from "../db/schema/common/auth";

type Db = PostgresJsDatabase<typeof schema>;

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

async function seedPlatformAdmin(db: Db, email: string): Promise<void> {
  const normalized = email.toLowerCase().trim();
  const user = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${normalized}`,
    columns: { id: true, email: true, name: true, isPlatformAdmin: true },
  });

  if (!user) {
    process.stderr.write(`[seed-platform-admin] No user found with email: ${normalized}\n`);
    process.exit(1);
  }

  await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));

  process.stdout.write(
    JSON.stringify({ ok: true, id: user.id, email: user.email, name: user.name ?? null, isPlatformAdmin: true }, null, 2) + "\n",
  );
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    process.stderr.write("Usage: node --env-file=.env -r ts-node/register src/scripts/seed-platform-admin.ts <email>\n");
    process.exit(1);
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");

  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema });
  try {
    await seedPlatformAdmin(db, email);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`[seed-platform-admin] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
