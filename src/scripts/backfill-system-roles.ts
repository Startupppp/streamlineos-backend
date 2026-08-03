import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import { organizations } from "../db/schema";
import { seedSystemRolesForOrg } from "../modules/rbac/seed-system-roles";
import { runWithTenantContext, withTenant } from "../common/tenant";

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

interface OrgSummary {
  orgId: string;
  created: number;
}

async function run(db: Database): Promise<OrgSummary[]> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const results: OrgSummary[] = [];

  for (const org of orgs) {
    await withTenant(db, { orgId: org.id, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId: org.id, audience: "INTERNAL", tx }, async () => {
        const { created } = await seedSystemRolesForOrg(tx, org.id);
        results.push({ orgId: org.id, created });
      }),
    );
  }

  return results;
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
    const results = await run(db);
    const totalCreated = results.reduce((sum, r) => sum + r.created, 0);
    process.stdout.write(
      JSON.stringify(
        {
          backfill: "complete",
          orgsProcessed: results.length,
          totalRolesCreated: totalCreated,
          perOrg: results,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("42P01")) {
      process.stderr.write(
        "[backfill-system-roles] Required tables are missing. Run migrations first (pnpm db:push or pnpm migrate).\n",
      );
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
    process.stderr.write(
      `[backfill-system-roles] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
