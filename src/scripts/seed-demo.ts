import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  users,
  organizations,
  organizationMembers,
  roles,
  invitations,
} from "../db/schema/common/auth";
import { orgUnits } from "../db/schema/common/organization";
import { subscriptions } from "../db/schema/common/subscriptions";
import { auditLogs } from "../db/schema/common/audit-logs";
import { DEFAULT_REGION } from "../common/region/region-registry";

type Db = PostgresJsDatabase<typeof schema>;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

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

const DEMO_ORG_ID = "d0000001-0000-4000-8000-000000000001";
const DEMO_USER_ID = "d0000001-0000-4000-8000-000000000002";
const DEMO_EMAIL = "demo@streamlineos.in";
const DEMO_ORG_SLUG = "demo-workspace-seed";

const MEMBER_CONFIGS = [
  {
    id: "d0000001-0000-4000-8000-000000000003",
    email: "alice.hr@demo.streamlineos.in",
    firstName: "Alice",
    lastName: "Johnson",
    role: "HR",
    userStatus: "active",
  },
  {
    id: "d0000001-0000-4000-8000-000000000004",
    email: "bob.sales@demo.streamlineos.in",
    firstName: "Bob",
    lastName: "Smith",
    role: "SALES",
    userStatus: "active",
  },
  {
    id: "d0000001-0000-4000-8000-000000000005",
    email: "carol.eng@demo.streamlineos.in",
    firstName: "Carol",
    lastName: "White",
    role: "ENGINEERING",
    userStatus: "active",
  },
  {
    id: "d0000001-0000-4000-8000-000000000006",
    email: "dan.design@demo.streamlineos.in",
    firstName: "Dan",
    lastName: "Brown",
    role: "DESIGN",
    userStatus: "active",
  },
  {
    id: "d0000001-0000-4000-8000-000000000007",
    email: "eve.suspended@demo.streamlineos.in",
    firstName: "Eve",
    lastName: "Davis",
    role: "ENGINEERING",
    userStatus: "suspended",
  },
] as const;

const BRANCH_CONFIGS = [
  { name: "Headquarters", code: "HQ", city: "Mumbai", state: "Maharashtra", country: "IN" },
  { name: "South Office", code: "SO", city: "Bangalore", state: "Karnataka", country: "IN" },
  { name: "North Hub", code: "NH", city: "Delhi", state: "Delhi", country: "IN" },
];

const DEPT_CONFIGS = [
  { name: "Engineering", code: "ENG", description: "Product engineering team" },
  { name: "Human Resources", code: "HR", description: "People operations" },
  { name: "Sales & Growth", code: "SALES", description: "Revenue generation" },
  { name: "Design", code: "DESIGN", description: "Product design" },
];

const TEAM_CONFIGS = [
  { name: "Backend Team", code: "BE", description: "Server-side development" },
  { name: "Frontend Team", code: "FE", description: "Client-side development" },
  { name: "Sales Ops", code: "SOPS", description: "Sales operations" },
  { name: "Talent Acquisition", code: "TA", description: "Recruitment team" },
];

const HR_DEPT_NAMES = ["Engineering", "Human Resources", "Sales", "Design"] as const;

interface SeedSummary {
  orgCreated: boolean;
  demoUserUpserted: boolean;
  memberUsersInserted: number;
  memberUsersSkipped: number;
  subscriptionCreated: boolean;
  rolesInserted: number;
  branchesInserted: number;
  orgDeptsInserted: number;
  orgTeamsInserted: number;
  orgLocationsInserted: number;
  hrDeptsInserted: number;
  invitationsInserted: number;
  auditLogsInserted: number;
}

async function seed(db: Db): Promise<SeedSummary> {
  const summary: SeedSummary = {
    orgCreated: false,
    demoUserUpserted: false,
    memberUsersInserted: 0,
    memberUsersSkipped: 0,
    subscriptionCreated: false,
    rolesInserted: 0,
    branchesInserted: 0,
    orgDeptsInserted: 0,
    orgTeamsInserted: 0,
    orgLocationsInserted: 0,
    hrDeptsInserted: 0,
    invitationsInserted: 0,
    auditLogsInserted: 0,
  };

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const invExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [ownerSeqRow] = await db.execute(
    sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
  );
  const ownerMembershipId = Number(ownerSeqRow?.id);

  const orgRows = await db
    .insert(organizations)
    .values({
      id: DEMO_ORG_ID,
      region: DEFAULT_REGION,
      ownerMembershipId,
      name: "Demo Workspace",
      slug: DEMO_ORG_SLUG,
      industry: "Technology",
      companySize: "11-50",
      country: "IN",
      onboardingCompletedAt: now,
      status: "ACTIVE",
    })
    .onConflictDoNothing({ target: organizations.id })
    .returning({ id: organizations.id });
  summary.orgCreated = orgRows.length > 0;

  const demoUserRows = await db
    .insert(users)
    .values({
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      name: "Demo Owner",
      firstName: "Demo",
      lastName: "Owner",
      emailVerified: now,
      isActive: true,
      userStatus: "active",
      lastActiveOrgId: DEMO_ORG_ID,
      activatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        isActive: true,
        userStatus: "active",
        emailVerified: now,
        lastActiveOrgId: DEMO_ORG_ID,
      },
    })
    .returning({ id: users.id });

  summary.demoUserUpserted = demoUserRows.length > 0;
  const actualDemoUserId: string = demoUserRows[0]?.id ?? DEMO_USER_ID;

  await db
    .insert(organizationMembers)
    .values({
      id: ownerMembershipId,
      userId: actualDemoUserId,
      orgId: DEMO_ORG_ID,
      isOwner: true,
    })
    .onConflictDoNothing();

  for (const m of MEMBER_CONFIGS) {
    const memberRows = await db
      .insert(users)
      .values({
        id: m.id,
        email: m.email,
        name: `${m.firstName} ${m.lastName}`,
        firstName: m.firstName,
        lastName: m.lastName,
        emailVerified: now,
        isActive: m.userStatus !== "suspended",
        userStatus: m.userStatus,
        lastActiveOrgId: DEMO_ORG_ID,
        activatedAt: now,
        archivedAt: m.userStatus === "suspended" ? now : null,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });

    if (memberRows.length > 0) {
      summary.memberUsersInserted++;
      const memberId = memberRows[0]!.id;
      await db
        .insert(organizationMembers)
        .values({
          userId: memberId,
          orgId: DEMO_ORG_ID,
          isOwner: false,
        })
        .onConflictDoNothing();
    } else {
      summary.memberUsersSkipped++;
    }
  }

  const existingSub = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, DEMO_ORG_ID))
    .limit(1);

  if (existingSub.length === 0) {
    await db.insert(subscriptions).values({
      orgId: DEMO_ORG_ID,
      plan: "STARTER",
      status: "TRIAL",
      trialEndsAt: trialEnd,
    });
    summary.subscriptionCreated = true;
  }

  const roleRows = await db
    .insert(roles)
    .values({
      name: "Administrator",
      slug: "ADMINISTRATOR",
      orgId: DEMO_ORG_ID,
      isSystem: false,
    })
    .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
    .returning({ id: roles.id });
  summary.rolesInserted = roleRows.length;

  for (const b of BRANCH_CONFIGS) {
    const rows = await db
      .insert(orgUnits)
      .values({
        orgId: DEMO_ORG_ID,
        kind: "BRANCH",
        name: b.name,
        code: b.code,
        metadata: { city: b.city, state: b.state, country: b.country },
        status: "ACTIVE",
      })
      .onConflictDoNothing()
      .returning({ id: orgUnits.id });
    summary.branchesInserted += rows.length;
  }

  for (const d of DEPT_CONFIGS) {
    const rows = await db
      .insert(orgUnits)
      .values({
        orgId: DEMO_ORG_ID,
        kind: "DEPARTMENT",
        name: d.name,
        code: d.code,
        description: d.description,
        status: "ACTIVE",
      })
      .onConflictDoNothing()
      .returning({ id: orgUnits.id });
    summary.orgDeptsInserted += rows.length;
  }

  for (const t of TEAM_CONFIGS) {
    const rows = await db
      .insert(orgUnits)
      .values({
        orgId: DEMO_ORG_ID,
        kind: "TEAM",
        name: t.name,
        code: t.code,
        description: t.description,
      })
      .onConflictDoNothing()
      .returning({ id: orgUnits.id });
    summary.orgTeamsInserted += rows.length;
  }

  const existingLocations = await db
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, DEMO_ORG_ID), eq(orgUnits.kind, "LOCATION")));

  if (existingLocations.length === 0) {
    const locationValues = [
      {
        orgId: DEMO_ORG_ID,
        kind: "LOCATION" as const,
        name: "Mumbai HQ Office",
        code: "MUMB",
        metadata: { city: "Mumbai", locationType: "OFFICE" as const, address: "BKC, Bandra East, Mumbai 400051" },
      },
      {
        orgId: DEMO_ORG_ID,
        kind: "LOCATION" as const,
        name: "Bangalore Tech Park",
        code: "BANG",
        metadata: { city: "Bangalore", locationType: "OFFICE" as const, address: "Outer Ring Road, Marathahalli, Bangalore 560037" },
      },
    ];
    const locRows = await db.insert(orgUnits).values(locationValues).returning({ id: orgUnits.id });
    summary.orgLocationsInserted = locRows.length;
  }

  const deptCodeMap: Record<string, string> = {
    Engineering: "ENG",
    "Human Resources": "HR",
    Sales: "SALES",
    Design: "DESIGN",
  };
  const deptRows = await db
    .insert(orgUnits)
    .values(
      HR_DEPT_NAMES.map((name) => ({
        orgId: DEMO_ORG_ID,
        kind: "DEPARTMENT" as const,
        name,
        code: deptCodeMap[name] ?? name.substring(0, 6).toUpperCase(),
        headMembershipId: ownerMembershipId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: orgUnits.id });
  summary.hrDeptsInserted = deptRows.length;

  const invRows = await db
    .insert(invitations)
    .values([
      {
        id: "d0000001-0000-4000-8000-000000000101",
        email: "invited1@demo.streamlineos.in",
        tokenHash: hashToken("demo-invite-raw-token-alpha-2026"),
        orgId: DEMO_ORG_ID,
        role: "HR",
        expiresAt: invExpiry,
      },
      {
        id: "d0000001-0000-4000-8000-000000000102",
        email: "invited2@demo.streamlineos.in",
        tokenHash: hashToken("demo-invite-raw-token-beta-2026"),
        orgId: DEMO_ORG_ID,
        role: "ENGINEERING",
        expiresAt: invExpiry,
      },
    ])
    .onConflictDoNothing()
    .returning({ id: invitations.id });
  summary.invitationsInserted = invRows.length;

  const existingAuditLogs = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.orgId, DEMO_ORG_ID))
    .limit(1);

  if (existingAuditLogs.length === 0) {
    const logRows = await db
      .insert(auditLogs)
      .values([
        {
          action: "org.created",
          userId: actualDemoUserId,
          orgId: DEMO_ORG_ID,
          targetId: DEMO_ORG_ID,
          targetType: "organization",
          resourceType: "organization",
          resourceId: DEMO_ORG_ID,
          metadata: { name: "Demo Workspace" },
        },
        {
          action: "user.login",
          userId: actualDemoUserId,
          orgId: DEMO_ORG_ID,
          targetId: actualDemoUserId,
          targetType: "user",
          resourceType: "user",
          resourceId: actualDemoUserId,
          metadata: { email: DEMO_EMAIL },
        },
        {
          action: "member.invited",
          userId: actualDemoUserId,
          orgId: DEMO_ORG_ID,
          targetType: "invitation",
          metadata: { email: "invited1@demo.streamlineos.in" },
        },
      ])
      .returning({ id: auditLogs.id });
    summary.auditLogsInserted = logRows.length;
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
    process.stdout.write("Running demo seed...\n");
    const summary = await seed(db);
    process.stdout.write(JSON.stringify({ seed: "complete", ...summary }, null, 2) + "\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("42P01")) {
      process.stderr.write("[seed-demo] Required tables are missing. Run migrations first.\n");
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
      `[seed-demo] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
