import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  moduleOwnerships,
  orgModules,
  organizationMembers,
  organizations,
} from "../db/schema";
import { ACCESS_MANAGED_MODULES } from "../modules/rbac/permissions";

type Database = PostgresJsDatabase<typeof schema>;

const OWNERSHIP_MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

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
  orgModulesConsidered: number;
  alreadyHadOwnership: number;
  ownershipRowsInserted: number;
  skippedNoOwnerMembership: number;
}

async function backfill(db: Database): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    orgModulesConsidered: 0,
    alreadyHadOwnership: 0,
    ownershipRowsInserted: 0,
    skippedNoOwnerMembership: 0,
  };

  const managedKeys = Array.from(OWNERSHIP_MANAGED_MODULES);

  const orgModuleRows = await db
    .select({ orgId: orgModules.orgId, moduleKey: orgModules.moduleKey })
    .from(orgModules)
    .where(
      and(
        eq(orgModules.enabled, true),
        inArray(orgModules.moduleKey, managedKeys),
      ),
    );

  summary.orgModulesConsidered = orgModuleRows.length;

  if (orgModuleRows.length === 0) return summary;

  const existingOwnershipRows = await db
    .select({ orgId: moduleOwnerships.orgId, moduleKey: moduleOwnerships.moduleKey })
    .from(moduleOwnerships);

  const existingSet = new Set(existingOwnershipRows.map((r) => `${r.orgId}:${r.moduleKey}`));

  const missingRows = orgModuleRows.filter((r) => !existingSet.has(`${r.orgId}:${r.moduleKey}`));

  summary.alreadyHadOwnership = orgModuleRows.length - missingRows.length;

  if (missingRows.length === 0) return summary;

  const uniqueOrgIds = [...new Set(missingRows.map((r) => r.orgId))];

  const orgRows = await db
    .select({ id: organizations.id, ownerMembershipId: organizations.ownerMembershipId })
    .from(organizations)
    .where(inArray(organizations.id, uniqueOrgIds));

  const ownerByOrgId = new Map<string, number>();
  for (const row of orgRows) {
    if (row.ownerMembershipId !== null && row.ownerMembershipId !== undefined) {
      ownerByOrgId.set(row.id, row.ownerMembershipId);
    }
  }

  const orgsWithNullOwner = orgRows
    .filter((r) => r.ownerMembershipId === null || r.ownerMembershipId === undefined)
    .map((r) => r.id);

  if (orgsWithNullOwner.length > 0) {
    const fallbackRows = await db
      .select({ id: organizationMembers.id, orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(
        and(
          inArray(organizationMembers.orgId, orgsWithNullOwner),
          eq(organizationMembers.isOwner, true),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      );
    for (const row of fallbackRows) {
      ownerByOrgId.set(row.orgId, row.id);
    }
  }

  const toInsert: { orgId: string; moduleKey: string; ownerMembershipId: number }[] = [];
  for (const row of missingRows) {
    const ownerMembershipId = ownerByOrgId.get(row.orgId);
    if (ownerMembershipId === undefined) {
      summary.skippedNoOwnerMembership += 1;
      continue;
    }
    toInsert.push({ orgId: row.orgId, moduleKey: row.moduleKey, ownerMembershipId });
  }

  if (toInsert.length > 0) {
    const inserted = await db
      .insert(moduleOwnerships)
      .values(toInsert)
      .onConflictDoNothing()
      .returning({ orgId: moduleOwnerships.orgId, moduleKey: moduleOwnerships.moduleKey });
    summary.ownershipRowsInserted = inserted.length;
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
      process.stderr.write(
        "[backfill-module-ownership] Required tables are missing. Run migrations first (pnpm db:push or pnpm migrate).\n",
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
      `[backfill-module-ownership] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
