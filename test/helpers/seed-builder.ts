import { and, eq, inArray, sql } from "drizzle-orm";
import {
  organizationMembers,
  organizations,
  pmWorkspaces,
  projectMembers,
  projects,
  roleAssignments,
  rolePermissionGrants,
  roles,
  subscriptions,
  users,
} from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";
import { ORG_MEMBER_ROLES, type OrgMemberRole } from "src/common/rbac/org-roles";
import { regionForNewOrg } from "src/common/region/region-registry";

export interface SeededMember {
  userId: string;
  membershipId: number;
}

export interface SeededProject {
  projectId: number;
  pmWorkspaceId: string;
}

export interface SeededFixture {
  orgId: string;
  members: Readonly<Record<string, SeededMember>>;
  projects: Readonly<Record<string, SeededProject>>;
  grantPermissions(memberAlias: string, permissionKeys: readonly string[]): Promise<void>;
  teardown(): Promise<void>;
  label(): string;
}

interface MemberSpec {
  email?: string;
  permissionKeys?: readonly string[];
  standing?: OrgMemberRole;
}

type PlanSeedTier = "PAID" | "ENTERPRISE";

interface ProjectSpec {
  name?: string;
  key?: string;
}

interface ProjectMemberEntry {
  memberAlias: string;
  role: string;
}

interface ProjectSeedEntry {
  name: string;
  key: string;
  memberEntries: ProjectMemberEntry[];
}

export class SeedBuilder {
  private readonly memberSpecs = new Map<string, Required<MemberSpec>>();
  private planSeedTier: PlanSeedTier | null = null;
  private readonly projectSeedEntries = new Map<string, ProjectSeedEntry>();

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
  ) {}

  addMember(alias: string, spec: MemberSpec = {}): this {
    const standing = spec.standing ?? ORG_MEMBER_ROLES.MEMBER;
    if (standing === ORG_MEMBER_ROLES.OWNER)
      for (const [, s] of this.memberSpecs)
        if (s.standing === ORG_MEMBER_ROLES.OWNER)
          throw new Error(`seed: only one alias may carry standing OWNER (org ${this.orgId})`);
    this.memberSpecs.set(alias, {
      email: spec.email ?? `${alias}-${this.orgId}@test.invalid`,
      permissionKeys: spec.permissionKeys ?? [],
      standing,
    });
    return this;
  }

  onPlan(tier: PlanSeedTier): this {
    this.planSeedTier = tier;
    return this;
  }

  addProject(projectAlias: string, spec: ProjectSpec = {}): this {
    const name = spec.name ?? projectAlias;
    const key =
      spec.key ??
      (projectAlias.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || "PROJ");
    this.projectSeedEntries.set(projectAlias, { name, key, memberEntries: [] });
    return this;
  }

  addProjectMember(projectAlias: string, memberAlias: string, role = "CONTRIBUTOR"): this {
    const entry = this.projectSeedEntries.get(projectAlias);
    if (!entry) throw new Error(`seed: project "${projectAlias}" not registered; call addProject first`);
    entry.memberEntries.push({ memberAlias, role });
    return this;
  }

  async build(): Promise<SeededFixture> {
    const { db, orgId } = this;
    const allUserIds: string[] = [];
    const members: Record<string, SeededMember> = {};
    const seededProjects: Record<string, SeededProject> = {};

    const ownerAliasEntry = [...this.memberSpecs.entries()].find(([, s]) => s.standing === ORG_MEMBER_ROLES.OWNER);

    // fk_organizations_owner_membership defers only inside a transaction, so the org and its owner membership must land in one.
    await db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.["id"]);
      if (!Number.isInteger(ownerMembershipId))
        throw new Error(`seed: could not allocate owner membership id for ${orgId}`);

      /**
       * Placed, like every organisation the product itself creates.
       *
       * All three real creation paths call `regionForNewOrg()`; only this
       * fixture did not, so a seeded org was unreachable the moment any code
       * resolved its region — which every tenant transaction does.
       */
      await tx.insert(organizations).values({
        id: orgId,
        name: orgId,
        slug: orgId,
        ownerMembershipId,
        region: regionForNewOrg(),
      });

      if (ownerAliasEntry) {
        const [alias, spec] = ownerAliasEntry;
        const userId = crypto.randomUUID();
        allUserIds.push(userId);
        await tx.insert(users).values({ id: userId, email: spec.email });
        await tx.insert(organizationMembers).values({
          id: ownerMembershipId,
          userId,
          orgId,
          role: ORG_MEMBER_ROLES.OWNER,
          isOwner: true,
          status: "ACTIVE",
        });
        members[alias] = { userId, membershipId: ownerMembershipId };
      } else {
        const ownerUserId = crypto.randomUUID();
        allUserIds.push(ownerUserId);
        await tx.insert(users).values({ id: ownerUserId, email: `owner-${orgId}@test.invalid` });
        await tx.insert(organizationMembers).values({
          id: ownerMembershipId,
          userId: ownerUserId,
          orgId,
          role: ORG_MEMBER_ROLES.OWNER,
          isOwner: true,
          status: "ACTIVE",
        });
      }

      for (const [alias, spec] of this.memberSpecs) {
        if (ownerAliasEntry && alias === ownerAliasEntry[0]) continue;
        const userId = crypto.randomUUID();
        allUserIds.push(userId);
        await tx.insert(users).values({ id: userId, email: spec.email });
        const [memberRow] = await tx
          .insert(organizationMembers)
          .values({ userId, orgId, role: spec.standing, isOwner: false, status: "ACTIVE" })
          .returning({ id: organizationMembers.id });
        if (!memberRow) throw new Error(`seed: member "${alias}" missing for org ${orgId}`);
        members[alias] = { userId, membershipId: memberRow.id };
      }

      if (this.planSeedTier !== null) {
        // STARTER is what PlanLimitsService resolves to tier PAID; there is no plan literally named PAID.
        const plan = this.planSeedTier === "ENTERPRISE" ? "ENTERPRISE" : "STARTER";
        await tx.insert(subscriptions).values({ orgId, plan, status: "ACTIVE" });
      }

      for (const [projectAlias, entry] of this.projectSeedEntries) {
        const pmWorkspaceId = crypto.randomUUID();
        await tx.insert(pmWorkspaces).values({
          pmWorkspaceId,
          orgId,
          name: `ws-${entry.name}`,
          slug: `ws-${entry.key.toLowerCase()}-${orgId.slice(0, 8)}`,
          isDefault: false,
          status: "active",
        });
        const [projectRow] = await tx
          .insert(projects)
          .values({ orgId, name: entry.name, key: entry.key, pmWorkspaceId, status: "ACTIVE" })
          .returning({ id: projects.id });
        if (!projectRow) throw new Error(`seed: project "${projectAlias}" insert failed for org ${orgId}`);
        const projectId = projectRow.id;
        seededProjects[projectAlias] = { projectId, pmWorkspaceId };

        for (const { memberAlias, role } of entry.memberEntries) {
          const member = members[memberAlias];
          if (!member) throw new Error(`seed: project member alias "${memberAlias}" not found for project "${projectAlias}"`);
          await tx.insert(projectMembers).values({ orgId, projectId, userId: member.userId, role });
        }
      }
    });

    for (const [alias, spec] of this.memberSpecs) {
      const member = members[alias];
      if (member && spec.permissionKeys.length > 0)
        await createRoleGrant(db, orgId, member.membershipId, spec.permissionKeys);
    }

    const orgRow = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
    if (!orgRow) throw new Error(`seed assertion: org ${orgId} not found`);

    const memberRows = await db.query.organizationMembers.findMany({
      where: and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, allUserIds)),
    });
    if (memberRows.length !== allUserIds.length)
      throw new Error(`seed assertion: expected ${allUserIds.length} members, found ${memberRows.length} (org=${orgId})`);

    if (this.planSeedTier !== null) {
      const subRow = await db.query.subscriptions.findFirst({
        where: and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "ACTIVE")),
      });
      if (!subRow) throw new Error(`seed assertion: active subscription not found for org ${orgId}`);
    }

    for (const [projectAlias, { projectId }] of Object.entries(seededProjects)) {
      const projRow = await db.query.projects.findFirst({
        where: and(eq(projects.orgId, orgId), eq(projects.id, projectId)),
      });
      if (!projRow) throw new Error(`seed assertion: project "${projectAlias}" not found for org ${orgId}`);
    }

    const grantPermissions = async (alias: string, permissionKeys: readonly string[]): Promise<void> => {
      const member = members[alias];
      if (!member) throw new Error(`seed: unknown member alias "${alias}" in org ${orgId}`);
      await createRoleGrant(db, orgId, member.membershipId, permissionKeys);
    };

    return {
      orgId,
      members,
      projects: seededProjects,
      grantPermissions,
      label: () =>
        `org=${orgId} members=${JSON.stringify(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, v.userId])))}`,
      teardown: async () => {
        await db.delete(organizations).where(eq(organizations.id, orgId));
        await db.delete(users).where(inArray(users.id, allUserIds));
      },
    };
  }
}

async function createRoleGrant(
  db: Db,
  orgId: string,
  membershipId: number,
  permissionKeys: readonly string[],
): Promise<void> {
  const slug = `seed-${crypto.randomUUID().slice(0, 12)}`;
  const [roleRow] = await db
    .insert(roles)
    .values({ name: slug, slug, orgId, rank: 40 })
    .returning({ id: roles.id });
  if (!roleRow) throw new Error(`seed: role creation failed for org ${orgId}`);

  await db.insert(rolePermissionGrants).values(
    permissionKeys.map((permissionKey) => ({
      orgId,
      roleId: roleRow.id,
      permissionKey,
      scope: "all" as const,
    })),
  );

  await db.insert(roleAssignments).values({
    orgId,
    organizationMembershipId: membershipId,
    roleId: roleRow.id,
  });

  await bumpPermissionsVersion(db, orgId);
  await waitForAccessVersionToPropagate();
}

/** access.service caches the org's permissions version for 1s; a grant is invisible until it lapses. */
const ACCESS_VERSION_CACHE_WINDOW_MS = 1_400;

function waitForAccessVersionToPropagate(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ACCESS_VERSION_CACHE_WINDOW_MS),
  );
}

export function seedOrg(db: Db, orgId = crypto.randomUUID()): SeedBuilder {
  return new SeedBuilder(db, orgId);
}
