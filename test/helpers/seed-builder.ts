import { and, eq, inArray, sql } from "drizzle-orm";
import {
  organizationMembers,
  organizations,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
} from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";

export interface SeededMember {
  userId: string;
  membershipId: number;
}

export interface SeededFixture {
  orgId: string;
  members: Readonly<Record<string, SeededMember>>;
  grantPermissions(memberAlias: string, permissionKeys: readonly string[]): Promise<void>;
  teardown(): Promise<void>;
  label(): string;
}

interface MemberSpec {
  email?: string;
  permissionKeys?: readonly string[];
}

export class SeedBuilder {
  private readonly memberSpecs = new Map<string, Required<MemberSpec>>();

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
  ) {}

  addMember(alias: string, spec: MemberSpec = {}): this {
    this.memberSpecs.set(alias, {
      email: spec.email ?? `${alias}-${this.orgId}@test.invalid`,
      permissionKeys: spec.permissionKeys ?? [],
    });
    return this;
  }

  async build(): Promise<SeededFixture> {
    const { db, orgId } = this;
    const allUserIds: string[] = [];
    const members: Record<string, SeededMember> = {};
    const ownerUserId = crypto.randomUUID();
    allUserIds.push(ownerUserId);

    // fk_organizations_owner_membership is DEFERRABLE INITIALLY DEFERRED, so the org
    // and the membership it points at must land in one transaction, as signup does.
    await db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.["id"]);
      if (!Number.isInteger(ownerMembershipId))
        throw new Error(`seed: could not allocate owner membership id for ${orgId}`);

      await tx
        .insert(organizations)
        .values({ id: orgId, name: orgId, slug: orgId, ownerMembershipId });
      await tx
        .insert(users)
        .values({ id: ownerUserId, email: `owner-${orgId}@test.invalid` });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        userId: ownerUserId,
        orgId,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
      });

      for (const [alias, spec] of this.memberSpecs) {
        const userId = crypto.randomUUID();
        allUserIds.push(userId);
        await tx.insert(users).values({ id: userId, email: spec.email });
        const [memberRow] = await tx
          .insert(organizationMembers)
          .values({ userId, orgId, role: "MEMBER", isOwner: false, status: "ACTIVE" })
          .returning({ id: organizationMembers.id });
        if (!memberRow) throw new Error(`seed: member "${alias}" missing for org ${orgId}`);
        members[alias] = { userId, membershipId: memberRow.id };
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

    const grantPermissions = async (alias: string, permissionKeys: readonly string[]): Promise<void> => {
      const member = members[alias];
      if (!member) throw new Error(`seed: unknown member alias "${alias}" in org ${orgId}`);
      await createRoleGrant(db, orgId, member.membershipId, permissionKeys);
    };

    return {
      orgId,
      members,
      grantPermissions,
      label: () => `org=${orgId} members=${JSON.stringify(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, v.userId])))}`,
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
