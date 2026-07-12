import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { organizations } from "../db/schema";
import { seedCrmDefaults } from "../modules/crm-metadata/crm-metadata-seed.service";

type Database = PostgresJsDatabase<typeof schema>;

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

interface BackfillSummary {
  organizations: number;
  seeded: number;
  skipped: number;
}

async function backfill(db: Database): Promise<BackfillSummary> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);

  const summary: BackfillSummary = {
    organizations: orgs.length,
    seeded: 0,
    skipped: 0,
  };

  for (const org of orgs) {
    try {
      await seedCrmDefaults(db, org.id);
      summary.seeded += 1;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[backfill-crm-metadata] org ${org.id} error: ${msg}\n`);
      summary.skipped += 1;
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema });
  try {
    const summary = await backfill(db);
    process.stdout.write(JSON.stringify({ backfill: "complete", ...summary }, null, 2) + "\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("42P01")) {
      process.stderr.write("[backfill-crm-metadata] Required tables are missing. Run migrations first.\n");
      process.exit(2);
    }
    throw err;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`[backfill-crm-metadata] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
