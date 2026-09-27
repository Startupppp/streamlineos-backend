import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { kbPageGrants, kbPages } from "../../../db/schema";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { buildGrantBranch, buildIndexedBranch } from "./authorization/knowledge-page-scope";
import type { KbActorStanding } from "./authorization/knowledge-authorization.types";

const suffix = randomUUID().slice(0, 8);
const ORG_A = `kblm-a-${suffix}`;
const ORG_B = `kblm-b-${suffix}`;
const USER_OWNER = `kblm-owner-${suffix}`;
const USER_SPACE_MEMBER = `kblm-sm-${suffix}`;
const USER_GRANT_ONLY = `kblm-go-${suffix}`;
const USER_B_OWNER = `kblm-b-owner-${suffix}`;

describe("KB page scope: leakage matrix — real database, RLS in force", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let ownerMembershipId = 0;
  let spaceMemberMembershipId = 0;
  let grantOnlyMembershipId = 0;

  let spaceId = 0;
  let pageOrgInSpace = 0;
  let pagePrivateInSpace = 0;
  let pageStandaloneOrg = 0;
  let pagePrivateGrantTarget = 0;
  let grantId = 0;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl) {
      throw new Error(
        "kb-page-scope-leakage-matrix.db.spec.ts requires DATABASE_URL (owner) and APP_DATABASE_URL (RLS role)",
      );
    }

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    db = drizzle(appClient, { schema });

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;

      for (const [uid, email, name] of [
        [USER_OWNER, `${USER_OWNER}@kblm.invalid`, "LM Owner"],
        [USER_SPACE_MEMBER, `${USER_SPACE_MEMBER}@kblm.invalid`, "LM Space Member"],
        [USER_GRANT_ONLY, `${USER_GRANT_ONLY}@kblm.invalid`, "LM Grant Only"],
        [USER_B_OWNER, `${USER_B_OWNER}@kblm.invalid`, "LM B Owner"],
      ] as const) {
        await tx`INSERT INTO users (id, email, name) VALUES (${uid}, ${email}, ${name})`;
      }

      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG_A}, 'LM Org A', ${ORG_A}, 0)`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG_B}, 'LM Org B', ${ORG_B}, 0)`;

      const [mOwner] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_OWNER}, ${ORG_A}, 'OWNER', true) RETURNING id`;
      const [mSpace] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_SPACE_MEMBER}, ${ORG_A}, 'MEMBER', false) RETURNING id`;
      const [mGrant] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_GRANT_ONLY}, ${ORG_A}, 'MEMBER', false) RETURNING id`;
      const [mBOwner] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_B_OWNER}, ${ORG_B}, 'OWNER', true) RETURNING id`;

      if (!mOwner || !mSpace || !mGrant || !mBOwner) throw new Error("seed: membership insert failed");
      ownerMembershipId = mOwner.id;
      spaceMemberMembershipId = mSpace.id;
      grantOnlyMembershipId = mGrant.id;

      await tx`UPDATE organizations SET owner_membership_id = ${ownerMembershipId} WHERE id = ${ORG_A}`;
      await tx`UPDATE organizations SET owner_membership_id = ${mBOwner.id} WHERE id = ${ORG_B}`;
    });

    const [space] = await owner<{ id: number }[]>`
      INSERT INTO kb_spaces (org_id, name, slug, type, default_visibility)
      VALUES (${ORG_A}, 'Private Space', ${`priv-space-${suffix}`}, 'team', 'org') RETURNING id`;
    if (!space) throw new Error("seed: space insert failed");
    spaceId = space.id;

    await owner`
      INSERT INTO kb_space_members (org_id, space_id, membership_id, space_role)
      VALUES (${ORG_A}, ${spaceId}, ${spaceMemberMembershipId}, 'viewer')`;

    const [p1] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, visibility, space_id, created_by_id, created_by_membership_id)
      VALUES (${ORG_A}, 'Org page in space', 'org', ${spaceId}, ${USER_OWNER}, ${ownerMembershipId}) RETURNING id`;
    const [p2] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, visibility, space_id, created_by_id, created_by_membership_id)
      VALUES (${ORG_A}, 'Private page in space', 'private', ${spaceId}, ${USER_OWNER}, ${ownerMembershipId}) RETURNING id`;
    const [p3] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, visibility, space_id, created_by_id, created_by_membership_id)
      VALUES (${ORG_A}, 'Standalone org page', 'org', null, ${USER_OWNER}, ${ownerMembershipId}) RETURNING id`;
    const [p4] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, visibility, space_id, created_by_id, created_by_membership_id)
      VALUES (${ORG_A}, 'Private grant target', 'private', null, ${USER_OWNER}, ${ownerMembershipId}) RETURNING id`;

    if (!p1 || !p2 || !p3 || !p4) throw new Error("seed: page insert failed");
    pageOrgInSpace = p1.id;
    pagePrivateInSpace = p2.id;
    pageStandaloneOrg = p3.id;
    pagePrivateGrantTarget = p4.id;

    const [g] = await owner<{ id: number }[]>`
      INSERT INTO kb_page_grants (org_id, page_id, membership_id, access, granted_by_membership_id)
      VALUES (${ORG_A}, ${pagePrivateGrantTarget}, ${grantOnlyMembershipId}, 'view', ${ownerMembershipId}) RETURNING id`;
    if (!g) throw new Error("seed: grant insert failed");
    grantId = g.id;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_page_grants WHERE org_id = ${ORG_A}`;
      await owner`DELETE FROM kb_space_members WHERE org_id = ${ORG_A}`;
      await owner`DELETE FROM kb_pages WHERE org_id IN (${ORG_A}, ${ORG_B})`;
      await owner`DELETE FROM kb_spaces WHERE org_id = ${ORG_A}`;
      for (const orgId of [ORG_A, ORG_B]) {
        await owner.begin(async (tx) => {
          await tx`SELECT set_config('app.audit_log_detachment', 'true', true)`;
          await tx`UPDATE audit_logs SET org_id = null, actor_membership_id = null, is_platform_event = true WHERE org_id = ${orgId}`;
          await tx`DELETE FROM organizations WHERE id = ${orgId}`;
        });
      }
      for (const uid of [USER_OWNER, USER_SPACE_MEMBER, USER_GRANT_ONLY, USER_B_OWNER]) {
        await owner`DELETE FROM users WHERE id = ${uid} AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id = ${uid})`;
      }
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  function standingFor(opts: {
    userId: string;
    membershipId: number;
    accessibleSpaceIds: number[];
  }): KbActorStanding {
    return {
      orgId: ORG_A,
      userId: opts.userId,
      membershipId: opts.membershipId,
      roleSlugs: [],
      isOrgOwner: false,
      isKbAdmin: false,
      accessibleSpaceIds: opts.accessibleSpaceIds,
      accessibleProjectIds: [],
      permissionsVersion: 1,
    };
  }

  async function visibleIds(standing: KbActorStanding): Promise<number[]> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${standing.orgId}, true)`);
      return runWithTenantContext({ orgId: standing.orgId, audience: "INTERNAL", tx }, async () => {
        const indexBranch = buildIndexedBranch(standing, "view");
        const grantBranch = buildGrantBranch(standing, "view");
        const predicate =
          grantBranch === null
            ? indexBranch
            : or(indexBranch, grantBranch);
        const rows = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, standing.orgId),
              isNull(kbPages.deletedAt),
              predicate,
            ),
          );
        return rows.map((r) => r.id).sort((a, b) => a - b);
      });
    });
  }

  it("space member sees org pages in their space and standalone org pages, not private pages", async () => {
    const standing = standingFor({
      userId: USER_SPACE_MEMBER,
      membershipId: spaceMemberMembershipId,
      accessibleSpaceIds: [spaceId],
    });

    const ids = await visibleIds(standing);

    expect(ids).toContain(pageOrgInSpace);
    expect(ids).toContain(pageStandaloneOrg);
    expect(ids).not.toContain(pagePrivateInSpace);
    expect(ids).not.toContain(pagePrivateGrantTarget);
  }, 60_000);

  it("grant-only member sees only their granted private page, not org pages in unjoined space", async () => {
    const standing = standingFor({
      userId: USER_GRANT_ONLY,
      membershipId: grantOnlyMembershipId,
      accessibleSpaceIds: [],
    });

    const ids = await visibleIds(standing);

    expect(ids).toContain(pageStandaloneOrg);
    expect(ids).toContain(pagePrivateGrantTarget);
    expect(ids).not.toContain(pageOrgInSpace);
    expect(ids).not.toContain(pagePrivateInSpace);
  }, 60_000);

  it("cross-tenant: org B actor with GUC set to org B sees zero pages from org A", async () => {
    const crossTenantStanding: KbActorStanding = {
      orgId: ORG_B,
      userId: USER_B_OWNER,
      membershipId: null,
      roleSlugs: [],
      isOrgOwner: false,
      isKbAdmin: false,
      accessibleSpaceIds: [],
      accessibleProjectIds: [],
      permissionsVersion: 1,
    };

    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG_B}, true)`);
      return runWithTenantContext({ orgId: ORG_B, audience: "INTERNAL", tx }, async () => {
        const indexBranch = buildIndexedBranch(crossTenantStanding, "view");
        const rows = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, ORG_B),
              isNull(kbPages.deletedAt),
              indexBranch,
            ),
          );
        return rows.map((r) => r.id);
      });
    });

    const orgAPageIds = [pageOrgInSpace, pagePrivateInSpace, pageStandaloneOrg, pagePrivateGrantTarget];
    for (const id of orgAPageIds) {
      expect(ids).not.toContain(id);
    }
  }, 60_000);

  it("revocation: after grant is revoked, grant-only member no longer sees the page", async () => {
    await owner`
      UPDATE kb_page_grants SET revoked_at = now()
      WHERE id = ${grantId}`;

    const standing = standingFor({
      userId: USER_GRANT_ONLY,
      membershipId: grantOnlyMembershipId,
      accessibleSpaceIds: [],
    });

    const ids = await visibleIds(standing);

    expect(ids).not.toContain(pagePrivateGrantTarget);
    expect(ids).toContain(pageStandaloneOrg);

    await owner`
      UPDATE kb_page_grants SET revoked_at = null
      WHERE id = ${grantId}`;
  }, 60_000);

  it("private page in space: being a space member does not grant access to private pages", async () => {
    const standing = standingFor({
      userId: USER_SPACE_MEMBER,
      membershipId: spaceMemberMembershipId,
      accessibleSpaceIds: [spaceId],
    });

    const ids = await visibleIds(standing);

    expect(ids).not.toContain(pagePrivateInSpace);
  }, 60_000);

  it("grant surface: the grant branch returns zero rows when grant is active and checked against wrong org GUC", async () => {
    const standing = standingFor({
      userId: USER_GRANT_ONLY,
      membershipId: grantOnlyMembershipId,
      accessibleSpaceIds: [],
    });

    const grantBranch = buildGrantBranch(standing, "view");

    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG_B}, true)`);
      return runWithTenantContext({ orgId: ORG_B, audience: "INTERNAL", tx }, async () => {
        if (grantBranch === null) return [];
        const rows = await tx
          .select({ id: kbPageGrants.id })
          .from(kbPageGrants)
          .where(
            and(
              eq(kbPageGrants.orgId, ORG_B),
              isNull(kbPageGrants.revokedAt),
              eq(kbPageGrants.membershipId, grantOnlyMembershipId),
            ),
          );
        return rows.map((r) => r.id);
      });
    });

    expect(ids).toHaveLength(0);
  }, 60_000);
});
