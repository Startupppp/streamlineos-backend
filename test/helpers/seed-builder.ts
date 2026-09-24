import { and, eq, inArray, sql } from "drizzle-orm";
import {
  orgModules,
  organizationMembers,
  organizations,
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
import {
  ORG_MEMBER_ROLES,
  type OrgMemberRole,
} from "src/common/rbac/org-roles";
import {
  placeOrganization,
  unplaceOrganization,
} from "src/common/region/placement-lookup";
import { DEFAULT_REGION } from "src/common/region/region-registry";

/**
 * `users` rows are inserted through raw SQL naming only the two columns a
 * seeded tenant actually needs.
 *
 * Drizzle's insert emits *every* declared column, defaulting the ones the
 * caller omitted — so a fixture that sets nothing but id and email still fails
 * the moment an unrelated module moves a user column. That is not
 * hypothetical: the HR employment refactor moved `joining_date`, `employee_id`,
 * `designation`, `monthly_salary`, `tax_id`, `bank_details`,
 * `org_department_id`, `reporting_to` and `branch_id` out to `hr_employments`
 * and migrated the shared database ahead of this branch, whose `users`
 * declaration still lists all nine. Every seeded e2e suite in the repo died on
 * `column "joining_date" of relation "users" does not exist`, in a fixture that
 * had never heard of the column.
 *
 * Naming the columns explicitly is also what the repo asks of production reads.
 * The declaration drift is real and still wants fixing where it lives; a test
 * fixture is not the place to be sensitive to it.
 */
async function insertSeedUser(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  id: string,
  email: string,
): Promise<void> {
  await tx.execute(sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`);
}

export interface SeededMember {
  userId: string;
  membershipId: number;
}

export interface SeededProject {
  projectId: number;
}

export interface SeededFixture {
  orgId: string;
  members: Readonly<Record<string, SeededMember>>;
  projects: Readonly<Record<string, SeededProject>>;
  grantPermissions(
    memberAlias: string,
    permissionKeys: readonly string[],
  ): Promise<void>;
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
  private readonly enabledModules = new Set<string>();
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
          throw new Error(
            `seed: only one alias may carry standing OWNER (org ${this.orgId})`,
          );
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

  /**
   * Plan-gated permission keys resolve to NO_MODULE until the org has an `org_modules`
   * row, so without this a grant of any `hr:*`/`build:*` key looks like a denial. Written
   * inside the build transaction because the module map is cached for 30 s per org.
   */
  withModules(...moduleKeys: readonly string[]): this {
    for (const key of moduleKeys) this.enabledModules.add(key);
    return this;
  }

  addProject(projectAlias: string, spec: ProjectSpec = {}): this {
    const name = spec.name ?? projectAlias;
    const key =
      spec.key ??
      (projectAlias
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase()
        .slice(0, 8) ||
        "PROJ");
    this.projectSeedEntries.set(projectAlias, { name, key, memberEntries: [] });
    return this;
  }

  addProjectMember(
    projectAlias: string,
    memberAlias: string,
    role = "CONTRIBUTOR",
  ): this {
    const entry = this.projectSeedEntries.get(projectAlias);
    if (!entry)
      throw new Error(
        `seed: project "${projectAlias}" not registered; call addProject first`,
      );
    entry.memberEntries.push({ memberAlias, role });
    return this;
  }

  async build(): Promise<SeededFixture> {
    const { db, orgId } = this;
    const allUserIds: string[] = [];
    const members: Record<string, SeededMember> = {};
    const seededProjects: Record<string, SeededProject> = {};

    const ownerAliasEntry = [...this.memberSpecs.entries()].find(
      ([, s]) => s.standing === ORG_MEMBER_ROLES.OWNER,
    );

    /**
     * `regionForOrg` reads `organization_placement`, not `organizations.region`, so the
     * legacy column below is not placement. Every real creation path places first and
     * inserts the org second (`auth.service.ts:83`, `org-setup-resolver.service.ts:219`);
     * a fixture that skipped it produced an org whose every tenant transaction threw
     * "has no region", which surfaces as 401 on every authenticated request.
     */
    await placeOrganization(db, { orgId, region: DEFAULT_REGION });

    // fk_organizations_owner_membership defers only inside a transaction, so the org and its owner membership must land in one.
    await db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.["id"]);
      if (!Number.isInteger(ownerMembershipId))
        throw new Error(
          `seed: could not allocate owner membership id for ${orgId}`,
        );

      await tx.insert(organizations).values({
        id: orgId,
        name: orgId,
        slug: orgId,
        ownerMembershipId,
        region: DEFAULT_REGION,
      });
      /**
       * The placement row is NOT written here. `placeOrganization` above already
       * wrote it, and a second insert of the same primary key aborted
       * `seedOrg().build()` with a 23505 — in `beforeAll`, so every seeded suite
       * on this branch reported as "test suite failed to run" with no case ever
       * executing. Two branches each added a placement and the merge kept both.
       */

      if (ownerAliasEntry) {
        const [alias, spec] = ownerAliasEntry;
        const userId = crypto.randomUUID();
        allUserIds.push(userId);
        await insertSeedUser(tx, userId, spec.email);
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
        await tx
          .insert(users)
          .values({ id: ownerUserId, email: `owner-${orgId}@test.invalid` });
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
        await insertSeedUser(tx, userId, spec.email);
        const [memberRow] = await tx
          .insert(organizationMembers)
          .values({
            userId,
            orgId,
            role: spec.standing,
            isOwner: false,
            status: "ACTIVE",
          })
          .returning({ id: organizationMembers.id });
        if (!memberRow)
          throw new Error(`seed: member "${alias}" missing for org ${orgId}`);
        members[alias] = { userId, membershipId: memberRow.id };
      }

      if (this.enabledModules.size > 0)
        await tx
          .insert(orgModules)
          .values([...this.enabledModules].map((moduleKey) => ({ orgId, moduleKey, enabled: true })));

      if (this.planSeedTier !== null) {
        // STARTER is what PlanLimitsService resolves to tier PAID; there is no plan literally named PAID.
        const plan =
          this.planSeedTier === "ENTERPRISE" ? "ENTERPRISE" : "STARTER";
        await tx
          .insert(subscriptions)
          .values({ orgId, plan, status: "ACTIVE" });
      }

      for (const [projectAlias, entry] of this.projectSeedEntries) {
        const [projectRow] = await tx
          .insert(projects)
          .values({
            orgId,
            name: entry.name,
            key: entry.key,
            status: "ACTIVE",
          })
          .returning({ id: projects.id });
        if (!projectRow)
          throw new Error(
            `seed: project "${projectAlias}" insert failed for org ${orgId}`,
          );
        const projectId = projectRow.id;
        seededProjects[projectAlias] = { projectId };

        for (const { memberAlias, role } of entry.memberEntries) {
          const member = members[memberAlias];
          if (!member)
            throw new Error(
              `seed: project member alias "${memberAlias}" not found for project "${projectAlias}"`,
            );
          await tx.insert(projectMembers).values({
            orgId,
            projectId,
            membershipId: member.membershipId,
            role,
          });
        }
      }
    });

    for (const [alias, spec] of this.memberSpecs) {
      const member = members[alias];
      if (member && spec.permissionKeys.length > 0)
        await createRoleGrant(
          db,
          orgId,
          member.membershipId,
          spec.permissionKeys,
        );
    }

    const orgRow = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    if (!orgRow) throw new Error(`seed assertion: org ${orgId} not found`);

    const memberRows = await db.query.organizationMembers.findMany({
      where: and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.userId, allUserIds),
      ),
    });
    if (memberRows.length !== allUserIds.length)
      throw new Error(
        `seed assertion: expected ${allUserIds.length} members, found ${memberRows.length} (org=${orgId})`,
      );

    if (this.planSeedTier !== null) {
      const subRow = await db.query.subscriptions.findFirst({
        where: and(
          eq(subscriptions.orgId, orgId),
          eq(subscriptions.status, "ACTIVE"),
        ),
      });
      if (!subRow)
        throw new Error(
          `seed assertion: active subscription not found for org ${orgId}`,
        );
    }

    for (const [projectAlias, { projectId }] of Object.entries(
      seededProjects,
    )) {
      const projRow = await db.query.projects.findFirst({
        where: and(eq(projects.orgId, orgId), eq(projects.id, projectId)),
      });
      if (!projRow)
        throw new Error(
          `seed assertion: project "${projectAlias}" not found for org ${orgId}`,
        );
    }

    const grantPermissions = async (
      alias: string,
      permissionKeys: readonly string[],
    ): Promise<void> => {
      const member = members[alias];
      if (!member)
        throw new Error(
          `seed: unknown member alias "${alias}" in org ${orgId}`,
        );
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
        /**
         * Audit rows first: `audit_logs.org_id` references `organizations`
         * without a cascade, on purpose — an audit trail that a delete could
         * quietly take with it is not one.
         *
         * The consequence for a fixture is that any test performing an audited
         * action — a merge, a plan change, anything through `AuditService` —
         * leaves a row that makes this delete fail, and the failure surfaces as
         * the whole suite erroring in `afterAll` with every test having passed.
         * Cleared here rather than in each spec, because which actions are
         * audited is not something a spec should have to know.
         */
        /**
         * Every table referencing `organizations` without a cascade blocks the
         * delete below, and which ones a fixture touched depends on what its
         * spec did. The children are read from the catalog rather than kept as
         * a hand-written list that goes stale the first time a module adds an
         * FK — the failure this replaces was a suite whose cases all passed and
         * whose `afterAll` erred with a constraint name and no indication of
         * which spec was responsible.
         *
         * `audit_logs` is one of them and is append-only for EVERYONE, not just
         * the app role: `audit_logs_append_only` raises on any DELETE including
         * the owner's. It is suspended for exactly this sweep, on the owner
         * connection, against a database `assertDisposableDatabase` has already
         * proved is a scratch target.
         */
        const blockers = await db.execute<{ child: string; column: string }>(
          sql`SELECT c.conrelid::regclass::text AS child,
                     a.attname                  AS column
                FROM pg_constraint c
                JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
               WHERE c.confrelid = 'organizations'::regclass
                 AND c.contype = 'f'
                 AND c.confdeltype IN ('a', 'r')
                 AND array_length(c.conkey, 1) = 1`,
        );
        await db.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
        try {
          for (const blocker of blockers)
            await db.execute(
              sql.raw(`DELETE FROM ${blocker.child} WHERE ${blocker.column} = '${orgId}'`),
            );
        } finally {
          await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`);
        }
        await db.delete(organizations).where(eq(organizations.id, orgId));
        await db.delete(users).where(inArray(users.id, allUserIds));
        // organization_placement carries no FK to organizations, so the row outlives the delete.
        await unplaceOrganization(db, orgId);
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
