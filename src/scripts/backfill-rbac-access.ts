import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  accessVersions,
  organizationMembers,
  organizations,
  permissions,
  rolePermissionGrants,
  roles,
  userRoles,
  users,
} from "../db/schema";
import { ROLE_DEFAULT_PERMISSIONS } from "../modules/rbac/permissions.constants";

type Database = PostgresJsDatabase<typeof schema>;

const SYSTEM_ROLE_NAMES: Record<string, string> = {
  OWNER: "Owner",
  CEO: "CEO",
  HR: "HR",
  SALES: "Sales",
  CUSTOMER_SUPPORT: "Customer Support",
  ENGINEERING: "Engineering",
  DESIGN: "Design",
  VIDEO_EDITOR: "Video Editor",
  DIGITAL_MARKETING: "Digital Marketing",
  BLOG_EDITOR: "Blog Editor",
  BRANCH_MANAGER: "Branch Manager",
  BRANCH_HR: "Branch HR",
  INVENTORY_MANAGER: "Inventory Manager",
  ACCOUNTANT: "Accountant",
};

function systemRoleName(slug: string): string {
  return (
    SYSTEM_ROLE_NAMES[slug] ??
    slug
      .split("_")
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(" ")
  );
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

interface BackfillSummary {
  organizations: number;
  systemRolesCreated: number;
  grantsInserted: number;
  userRolesInserted: number;
  userRolesSkipped: number;
  accessVersionsSeeded: number;
}

async function backfill(db: Database): Promise<BackfillSummary> {
  const catalogRows = await db.select({ name: permissions.name }).from(permissions);
  const catalog = new Set(catalogRows.map((row) => row.name));
  const systemSlugs = new Set(Object.keys(ROLE_DEFAULT_PERMISSIONS));

  const orgs = await db.select({ id: organizations.id }).from(organizations);

  const summary: BackfillSummary = {
    organizations: orgs.length,
    systemRolesCreated: 0,
    grantsInserted: 0,
    userRolesInserted: 0,
    userRolesSkipped: 0,
    accessVersionsSeeded: 0,
  };

  for (const org of orgs) {
    await db.transaction(async (tx) => {
      const members = await tx
        .select({ userId: organizationMembers.userId, role: users.role })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(eq(organizationMembers.orgId, org.id));

      const distinctRoles = [...new Set(members.map((member) => member.role))];

      for (const slug of distinctRoles) {
        if (!systemSlugs.has(slug)) continue;
        const created = await tx
          .insert(roles)
          .values({
            name: systemRoleName(slug),
            slug,
            orgId: org.id,
            isSystem: true,
            permissions: ROLE_DEFAULT_PERMISSIONS[slug] ?? [],
          })
          .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
          .returning({ id: roles.id });
        summary.systemRolesCreated += created.length;
      }

      const orgRoles = await tx
        .select({
          id: roles.id,
          slug: roles.slug,
          isSystem: roles.isSystem,
          permissions: roles.permissions,
        })
        .from(roles)
        .where(eq(roles.orgId, org.id));

      for (const role of orgRoles) {
        const rawKeys = role.isSystem ? ROLE_DEFAULT_PERMISSIONS[role.slug] ?? [] : role.permissions;
        const keys = [...new Set(rawKeys)].filter((key) => catalog.has(key));
        if (keys.length === 0) continue;
        const SALES_OWN_SCOPE_KEYS = new Set(["crm:leads:view", "crm:leads:update"]);
        const inserted = await tx
          .insert(rolePermissionGrants)
          .values(
            keys.map((permissionKey) => ({
              orgId: org.id,
              roleId: role.id,
              permissionKey,
              scope:
                role.slug === "SALES" && SALES_OWN_SCOPE_KEYS.has(permissionKey)
                  ? ("own" as const)
                  : ("all" as const),
            })),
          )
          .onConflictDoNothing({
            target: [rolePermissionGrants.roleId, rolePermissionGrants.permissionKey],
          })
          .returning({ id: rolePermissionGrants.id });
        summary.grantsInserted += inserted.length;
      }

      const roleIdBySlug = new Map(orgRoles.map((role) => [role.slug, role.id]));
      const userRoleRows: { orgId: string; userId: string; roleId: number }[] = [];
      for (const member of members) {
        const roleId = roleIdBySlug.get(member.role);
        if (roleId === undefined) {
          summary.userRolesSkipped += 1;
          continue;
        }
        userRoleRows.push({ orgId: org.id, userId: member.userId, roleId });
      }
      if (userRoleRows.length > 0) {
        const inserted = await tx
          .insert(userRoles)
          .values(userRoleRows)
          .onConflictDoNothing({
            target: [userRoles.orgId, userRoles.userId, userRoles.roleId],
          })
          .returning({ id: userRoles.id });
        summary.userRolesInserted += inserted.length;
      }

      const seeded = await tx
        .insert(accessVersions)
        .values({ orgId: org.id, permissionsVersion: 1 })
        .onConflictDoNothing({ target: accessVersions.orgId })
        .returning({ orgId: accessVersions.orgId });
      summary.accessVersionsSeeded += seeded.length;
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
    console.log("[backfill-rbac-access] summary:", JSON.stringify(summary, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("[backfill-rbac-access] failed:", error);
    process.exit(1);
  });
