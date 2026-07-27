import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  membershipRoleAssignments,
  organizationMembers,
  organizations,
  roles,
  userRoles,
  users,
} from "../db/schema";

type Database = PostgresJsDatabase<typeof schema>;

const BATCH_SIZE = 200;

const LEGACY_ROLE_SLUG_ALIASES: Readonly<Record<string, string>> = {
  FINANCE: "ACCOUNTANT",
};

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
  orgsProcessed: number;
  totalInserted: number;
  rowsSkipped: number;
}

type InsertRow = {
  organizationId: string;
  organizationMembershipId: number;
  roleId: number;
  assignedBy: string | null;
};

async function backfillOrg(
  db: Database,
  orgId: string,
  summary: BackfillSummary,
): Promise<void> {
  const members = await db
    .select({ id: organizationMembers.id, userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));

  if (members.length === 0) return;

  const memberByUserId = new Map(members.map((m) => [m.userId, m]));
  const memberUserIds = members.map((m) => m.userId);

  const existingUserRoles = await db
    .select({ userId: userRoles.userId, roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.orgId, orgId));

  const userIdsWithDirectRoles = new Set(existingUserRoles.map((ur) => ur.userId));

  const orgRoles = await db
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(eq(roles.orgId, orgId));
  const roleIdBySlug = new Map(orgRoles.map((r) => [r.slug, r.id]));

  const rowsToInsert: InsertRow[] = [];

  for (const ur of existingUserRoles) {
    const membership = memberByUserId.get(ur.userId);
    if (membership === undefined) {
      summary.rowsSkipped++;
      continue;
    }
    rowsToInsert.push({
      organizationId: orgId,
      organizationMembershipId: membership.id,
      roleId: ur.roleId,
      assignedBy: null,
    });
  }

  const legacyUserIds = memberUserIds.filter((uid) => !userIdsWithDirectRoles.has(uid));

  for (let i = 0; i < legacyUserIds.length; i += BATCH_SIZE) {
    const batch = legacyUserIds.slice(i, i + BATCH_SIZE);
    const userRecords = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(inArray(users.id, batch));

    for (const user of userRecords) {
      const membership = memberByUserId.get(user.id);
      if (membership === undefined) {
        summary.rowsSkipped++;
        continue;
      }
      const legacySlug = user.role === null ? null : user.role.toUpperCase();
      const canonicalSlug =
        legacySlug === null ? null : (LEGACY_ROLE_SLUG_ALIASES[legacySlug] ?? legacySlug);
      const roleId = canonicalSlug === null ? undefined : roleIdBySlug.get(canonicalSlug);
      if (roleId === undefined) {
        summary.rowsSkipped++;
        continue;
      }
      rowsToInsert.push({
        organizationId: orgId,
        organizationMembershipId: membership.id,
        roleId,
        assignedBy: null,
      });
    }
  }

  for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
    const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
    const inserted = await db
      .insert(membershipRoleAssignments)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: membershipRoleAssignments.id });
    summary.totalInserted += inserted.length;
  }
}

async function backfill(db: Database): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    orgsProcessed: 0,
    totalInserted: 0,
    rowsSkipped: 0,
  };

  const orgs = await db.select({ id: organizations.id }).from(organizations);

  for (const org of orgs) {
    await backfillOrg(db, org.id, summary);
    summary.orgsProcessed++;
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
    process.stdout.write(
      JSON.stringify({ backfill: "complete", ...summary }, null, 2) + "\n",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("does not exist") ||
      msg.includes("relation") ||
      msg.includes("42P01")
    ) {
      process.stderr.write(
        "[backfill-membership-role-assignments] Required tables are missing. Run migrations first.\n",
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
      `[backfill-membership-role-assignments] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
