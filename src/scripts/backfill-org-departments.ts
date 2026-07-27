import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import { organizations, departments, users, jobPostings, headcountRequests } from "../db/schema";
import { orgDepartments } from "../db/schema/common/organization";
import { nextDepartmentCode, toDepartmentCode } from "../modules/org-hierarchy/lib/department-code";

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
  orgDepartmentsCreated: number;
  usersUpdated: number;
  jobPostingsUpdated: number;
  headcountRequestsUpdated: number;
}

async function backfill(db: Database): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    organizations: 0,
    orgDepartmentsCreated: 0,
    usersUpdated: 0,
    jobPostingsUpdated: 0,
    headcountRequestsUpdated: 0,
  };

  const orgs = await db.select({ id: organizations.id }).from(organizations);
  summary.organizations = orgs.length;

  for (const org of orgs) {
    await db.transaction(async (tx) => {
      const legacyDepartments = await tx
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(eq(departments.orgId, org.id));

      if (legacyDepartments.length === 0) return;

      const existingOrgDepartments = await tx
        .select({
          id: orgDepartments.id,
          name: orgDepartments.name,
          code: orgDepartments.code,
        })
        .from(orgDepartments)
        .where(eq(orgDepartments.orgId, org.id));

      const byNormalizedName = new Map(
        existingOrgDepartments.map((d) => [d.name.trim().toLowerCase(), d.id]),
      );
      const usedCodes = new Set(existingOrgDepartments.map((d) => d.code));

      const legacyIdToOrgDepartmentId = new Map<number, string>();

      for (const legacy of legacyDepartments) {
        const key = legacy.name.trim().toLowerCase();
        let orgDepartmentId = byNormalizedName.get(key);

        if (!orgDepartmentId) {
          const base = toDepartmentCode(legacy.name);
          let code = base;
          let suffix = 2;
          while (usedCodes.has(code)) {
            code = nextDepartmentCode(base, suffix);
            suffix += 1;
          }
          usedCodes.add(code);

          const [created] = await tx
            .insert(orgDepartments)
            .values({
              orgId: org.id,
              name: legacy.name,
              code,
              status: "ACTIVE",
            })
            .returning({ id: orgDepartments.id });

          orgDepartmentId = created.id;
          byNormalizedName.set(key, orgDepartmentId);
          summary.orgDepartmentsCreated += 1;
        }

        legacyIdToOrgDepartmentId.set(legacy.id, orgDepartmentId);
      }

      for (const [legacyId, orgDepartmentId] of legacyIdToOrgDepartmentId) {
        const updatedUsers = await tx
          .update(users)
          .set({ orgDepartmentId })
          .where(
            and(
              eq(users.departmentId, legacyId),
              isNull(users.orgDepartmentId),
            ),
          )
          .returning({ id: users.id });
        summary.usersUpdated += updatedUsers.length;

        const updatedJobPostings = await tx
          .update(jobPostings)
          .set({ orgDepartmentId })
          .where(
            and(
              eq(jobPostings.orgId, org.id),
              eq(jobPostings.departmentId, legacyId),
              isNull(jobPostings.orgDepartmentId),
            ),
          )
          .returning({ id: jobPostings.id });
        summary.jobPostingsUpdated += updatedJobPostings.length;

        const updatedHeadcountRequests = await tx
          .update(headcountRequests)
          .set({ orgDepartmentId })
          .where(
            and(
              eq(headcountRequests.orgId, org.id),
              eq(headcountRequests.departmentId, legacyId),
              isNull(headcountRequests.orgDepartmentId),
            ),
          )
          .returning({ id: headcountRequests.id });
        summary.headcountRequestsUpdated += updatedHeadcountRequests.length;
      }
    });
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
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("42P01") || msg.includes("column")) {
      process.stderr.write(
        "[backfill-org-departments] Required columns are missing. Run migrations/0296_hrms_org_departments.sql first.\n",
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
    process.stderr.write(`[backfill-org-departments] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
