import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { and, count, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { DrizzleModule } from "../db/drizzle.module";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import type { RemovalAction } from "../modules/organization/core/membership-artifacts";
import {
  agentTokens,
  invitations,
  kbSpaceGrants,
  kbSpaces,
  organizationMembers,
  organizations,
  permissions,
  principalGroupMembers,
  principalGroups,
  resourceGrants,
  roleAssignments,
  roles,
  userDelegationPermissions,
  userDelegations,
  userModuleAccess,
  userPermissionGrants,
  users,
} from "../db/schema";
import { MEMBERSHIP_ARTIFACTS } from "../modules/organization/core/membership-artifacts";

@Module({ imports: [DrizzleModule] })
class RevocationContextModule {}

const TS = `${process.pid}${Date.now()}`;
const ORG_ID = `revoc-org-${TS}`;
const MEM_USER_ID = `revoc-mem-${TS}`;
const DEL_USER_ID = `revoc-del-${TS}`;
const MEM_EMAIL = `revoc-mem-${TS}@verify.invalid`;
const DEL_EMAIL = `revoc-del-${TS}@verify.invalid`;
const DELEGATION_ID = randomUUID();
const INV_ID = randomUUID();
const AGENT_TOKEN_HASH = createHash("sha256").update(`agent-${TS}`).digest("hex");
const AGENT_TOKEN_PREFIX = `sat_${TS.slice(0, 10)}`;

type CountRow = { n: unknown };
const toN = (r: CountRow | undefined): number => Number(r?.n ?? 0);

type ArtifactResult = { table: string; before: number; after: number; status: "PASS" | "FAIL" };

function buildResults(
  before: Record<string, number>,
  after: Record<string, number>,
): ArtifactResult[] {
  return Object.keys(before).map((table) => ({
    table,
    before: before[table] ?? 0,
    after: after[table] ?? 0,
    status: (after[table] ?? 0) === 0 ? "PASS" : "FAIL",
  }));
}

async function snapshot(
  db: Db,
  orgId: string,
  membershipId: number,
  userId: string,
  email: string,
): Promise<Record<string, number>> {
  return runInNewTenantTransaction(db, orgId, async (tx) => {
    const [ra] = await tx
      .select({ n: count() })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.orgId, orgId), eq(roleAssignments.organizationMembershipId, membershipId)));
    const [upg] = await tx
      .select({ n: count() })
      .from(userPermissionGrants)
      .where(and(eq(userPermissionGrants.orgId, orgId), eq(userPermissionGrants.organizationMembershipId, membershipId)));
    const [pgm] = await tx
      .select({ n: count() })
      .from(principalGroupMembers)
      .where(and(eq(principalGroupMembers.orgId, orgId), eq(principalGroupMembers.organizationMembershipId, membershipId)));
    const [uma] = await tx
      .select({ n: count() })
      .from(userModuleAccess)
      .where(and(eq(userModuleAccess.orgId, orgId), eq(userModuleAccess.organizationMembershipId, membershipId)));
    const [ud] = await tx
      .select({ n: count() })
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          or(eq(userDelegations.delegatorMembershipId, membershipId), eq(userDelegations.delegateeMembershipId, membershipId)),
        ),
      );
    const [udp] = await tx
      .select({ n: count() })
      .from(userDelegationPermissions)
      .where(and(eq(userDelegationPermissions.orgId, orgId), eq(userDelegationPermissions.delegationId, DELEGATION_ID)));
    const [at] = await tx
      .select({ n: count() })
      .from(agentTokens)
      .where(and(eq(agentTokens.orgId, orgId), eq(agentTokens.issuerMembershipId, membershipId)));
    const [rg] = await tx
      .select({ n: count() })
      .from(resourceGrants)
      .where(and(eq(resourceGrants.orgId, orgId), eq(resourceGrants.principalType, "user"), eq(resourceGrants.principalId, userId)));
    const [ksg] = await tx
      .select({ n: count() })
      .from(kbSpaceGrants)
      .where(and(eq(kbSpaceGrants.orgId, orgId), eq(kbSpaceGrants.principalType, "user"), eq(kbSpaceGrants.principalId, userId)));
    const [inv] = await tx
      .select({ n: count() })
      .from(invitations)
      .where(
        and(eq(invitations.orgId, orgId), eq(invitations.email, email), eq(invitations.status, "PENDING"), isNull(invitations.acceptedAt)),
      );
    return {
      role_assignments: toN(ra),
      user_permission_grants: toN(upg),
      principal_group_members: toN(pgm),
      user_module_access: toN(uma),
      user_delegations: toN(ud),
      user_delegation_permissions: toN(udp),
      agent_tokens: toN(at),
      resource_grants: toN(rg),
      kb_space_grants: toN(ksg),
      invitations_pending: toN(inv),
    };
  });
}

const ARTIFACT_COVERAGE: ReadonlySet<string> = new Set([
  "role_assignments", "user_permission_grants", "principal_group_members",
  "user_delegations", "user_module_access", "agent_tokens",
  "resource_grants", "kb_space_grants", "invitations",
]);

function printUncoveredArtifacts(): void {
  const uncovered = MEMBERSHIP_ARTIFACTS.filter(
    (a) => a.table !== null && a.onRemoval !== "blocks-removal" && a.onRemoval !== "set-null" && !ARTIFACT_COVERAGE.has(a.table),
  );
  if (uncovered.length > 0) {
    console.log("\nNOTICE — inventory artifacts not checked by this script:");
    uncovered.forEach((a) => console.log(`  ${a.table ?? ""} (${a.id})`));
  }
}

const FK_ACTION_BY_CODE: Record<string, RemovalAction> = {
  c: "cascade",
  n: "set-null",
  a: "blocks-removal",
  r: "blocks-removal",
};

async function checkArtifactFkDrift(db: Db): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT
      cl.relname AS table_name,
      c.conname AS constraint_name,
      c.confdeltype AS delete_code,
      (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE c.contype = 'f' AND c.confrelid = 'organization_members'::regclass
  `);
  const rows = Array.isArray(result) ? result : [];

  console.log("\n=== INVENTORY vs pg_constraint (declared onRemoval must match the real FK) ===");
  let pass = true;
  for (const artifact of MEMBERSHIP_ARTIFACTS) {
    if (artifact.table === null) continue;
    if (artifact.onRemoval !== "cascade" && artifact.onRemoval !== "set-null" && artifact.onRemoval !== "blocks-removal") continue;

    const match = rows.find((row) => {
      const record: Record<string, unknown> = row;
      if (String(record.table_name ?? "") !== artifact.table) return false;
      return String(record.columns ?? "").split(",").includes(artifact.keyedBy);
    });

    if (!match) {
      console.log(`  SKIP  ${(artifact.table ?? "").padEnd(34)} no FK on ${artifact.keyedBy} references organization_members`);
      continue;
    }

    const record: Record<string, unknown> = match;
    const actual = FK_ACTION_BY_CODE[String(record.delete_code ?? "")];
    const ok = actual === artifact.onRemoval;
    if (!ok) pass = false;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${(artifact.table ?? "").padEnd(34)} declared=${artifact.onRemoval} actual=${actual ?? "unknown"} (${String(record.constraint_name ?? "")})`,
    );
  }
  return pass;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RevocationContextModule, { logger: ["error"] });
  const db = app.get<Db>(DRIZZLE);

  let usersSeeded = false;
  let orgSeeded = false;

  try {
    const [permRow] = await db
      .select({ name: permissions.name, administeringModuleKey: permissions.administeringModuleKey })
      .from(permissions)
      .where(isNotNull(permissions.administeringModuleKey))
      .orderBy(permissions.name)
      .limit(1);
    if (!permRow) throw new Error("No permissions in DB — run pnpm seed:permissions first");
    const permKey = permRow.name;
    const permModuleKey = permRow.administeringModuleKey;
    if (permModuleKey === null) throw new Error(`Permission ${permKey} has no administering module — the catalog boot sync did not run`);

    await db.insert(users).values([
      { id: MEM_USER_ID, email: MEM_EMAIL, name: "Revoc Member" },
      { id: DEL_USER_ID, email: DEL_EMAIL, name: "Revoc Delegator" },
    ]);
    usersSeeded = true;

    // Org and all artifacts in one tenant transaction.
    // organizations.fk_organizations_owner_membership is DEFERRABLE INITIALLY DEFERRED,
    // so the placeholder ownerMembershipId is valid within the transaction and corrected
    // before COMMIT. The guard trigger on organization_members is safe because it queries
    // the org row, which is present by the time any membership is touched.
    const { memId } = await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
      await tx.insert(organizations).values({
        id: ORG_ID,
        name: "Revoc Test Org",
        slug: `revoc-${TS}`,
        ownerMembershipId: 0,
      });

      const [memRow] = await tx
        .insert(organizationMembers)
        .values({ userId: MEM_USER_ID, orgId: ORG_ID, role: "MEMBER", status: "ACTIVE", isOwner: false })
        .returning({ id: organizationMembers.id });
      if (!memRow) throw new Error("member insert failed");

      const [delRow] = await tx
        .insert(organizationMembers)
        .values({ userId: DEL_USER_ID, orgId: ORG_ID, role: "MEMBER", status: "ACTIVE", isOwner: true })
        .returning({ id: organizationMembers.id });
      if (!delRow) throw new Error("delegator insert failed");

      await tx.update(organizations).set({ ownerMembershipId: delRow.id }).where(eq(organizations.id, ORG_ID));

      const [roleRow] = await tx
        .insert(roles)
        .values({ name: `Revoc Role ${TS}`, slug: `revoc-role-${TS}`, orgId: ORG_ID, rank: 50 })
        .returning({ id: roles.id });
      if (!roleRow) throw new Error("role insert failed");

      await tx.insert(roleAssignments).values({ orgId: ORG_ID, organizationMembershipId: memRow.id, roleId: roleRow.id });
      await tx.insert(userPermissionGrants).values({ orgId: ORG_ID, organizationMembershipId: memRow.id, permissionKey: permKey, moduleKey: permModuleKey });

      const [groupRow] = await tx
        .insert(principalGroups)
        .values({ orgId: ORG_ID, kind: "CUSTOM", name: `Revoc Group ${TS}` })
        .returning({ id: principalGroups.id });
      if (!groupRow) throw new Error("group insert failed");

      await tx.insert(principalGroupMembers).values({ orgId: ORG_ID, principalGroupId: groupRow.id, organizationMembershipId: memRow.id });
      await tx.insert(userDelegations).values({
        id: DELEGATION_ID,
        orgId: ORG_ID,
        delegatorMembershipId: delRow.id,
        delegateeMembershipId: memRow.id,
        endsAt: new Date(Date.now() + 3_600_000),
        status: "ACTIVE",
      });
      await tx.insert(userDelegationPermissions).values({ orgId: ORG_ID, delegationId: DELEGATION_ID, permissionKey: permKey });
      await tx.insert(userModuleAccess).values({ orgId: ORG_ID, organizationMembershipId: memRow.id, moduleKey: "hr", enabled: false });
      await tx.insert(agentTokens).values({
        orgId: ORG_ID,
        userId: MEM_USER_ID,
        issuerMembershipId: memRow.id,
        scopes: ["read:org"],
        name: `Revoc Token ${TS}`,
        tokenHash: AGENT_TOKEN_HASH,
        tokenPrefix: AGENT_TOKEN_PREFIX,
      });
      await tx.insert(resourceGrants).values({ orgId: ORG_ID, resourceType: "project", resourceId: "fixture-999", principalType: "user", principalId: MEM_USER_ID, level: "viewer" });
      const [spaceRow] = await tx
        .insert(kbSpaces)
        .values({
          orgId: ORG_ID,
          name: `Revoc Space ${TS}`,
          slug: `revoc-space-${TS}`,
          createdById: DEL_USER_ID,
        })
        .returning({ id: kbSpaces.id });
      if (!spaceRow) throw new Error("kb space insert failed");
      await tx.insert(kbSpaceGrants).values({ orgId: ORG_ID, spaceId: spaceRow.id, principalType: "user", principalId: MEM_USER_ID, permissionKey: "kb:spaces:view" });
      await tx.insert(invitations).values({
        id: INV_ID,
        email: MEM_EMAIL,
        tokenHash: createHash("sha256").update(`inv-${TS}`).digest("hex"),
        orgId: ORG_ID,
        role: "MEMBER",
        invitedBy: DEL_USER_ID,
        expiresAt: new Date(Date.now() + 604_800_000),
        status: "PENDING",
      });

      return { memId: memRow.id };
    });
    orgSeeded = true;

    console.log(`\nThrowaway org: ${ORG_ID}  membershipId: ${memId}`);
    printUncoveredArtifacts();

    const before = await snapshot(db, ORG_ID, memId, MEM_USER_ID, MEM_EMAIL);
    console.log("\n=== BEFORE (each should be 1) ===");
    for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(30)} ${v}`);

    // Full removal path: explicit writes (agent_tokens revoke, delegation revoke,
    // resource_grants delete, kb_space_grants delete, invitation revoke), then
    // membership DELETE which cascades the FK-linked artifacts.
    const now = new Date();
    await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
      await tx.update(agentTokens).set({ revokedAt: now }).where(and(eq(agentTokens.orgId, ORG_ID), eq(agentTokens.issuerMembershipId, memId), isNull(agentTokens.revokedAt)));
      await tx.update(userDelegations).set({ status: "REVOKED", revokedAt: now }).where(and(eq(userDelegations.orgId, ORG_ID), eq(userDelegations.status, "ACTIVE"), or(eq(userDelegations.delegatorMembershipId, memId), eq(userDelegations.delegateeMembershipId, memId))));
      await tx.delete(resourceGrants).where(and(eq(resourceGrants.orgId, ORG_ID), eq(resourceGrants.principalType, "user"), eq(resourceGrants.principalId, MEM_USER_ID)));
      await tx.delete(kbSpaceGrants).where(and(eq(kbSpaceGrants.orgId, ORG_ID), eq(kbSpaceGrants.principalType, "user"), eq(kbSpaceGrants.principalId, MEM_USER_ID)));
      await tx.update(invitations).set({ status: "REVOKED", revokedAt: now }).where(and(eq(invitations.orgId, ORG_ID), eq(invitations.email, MEM_EMAIL), eq(invitations.status, "PENDING"), isNull(invitations.acceptedAt)));
      await tx.delete(organizationMembers).where(and(eq(organizationMembers.userId, MEM_USER_ID), eq(organizationMembers.orgId, ORG_ID)));
    });
    const t0 = Date.now();

    const after = await snapshot(db, ORG_ID, memId, MEM_USER_ID, MEM_EMAIL);
    const t1 = Date.now();

    const results = buildResults(before, after);
    let removalPass = true;
    console.log("\n=== REMOVAL RESULTS ===");
    for (const r of results) {
      const label = r.status === "PASS" ? "PASS" : "FAIL";
      console.log(`  ${label}  ${r.table.padEnd(30)} before=${r.before} after=${r.after}`);
      if (r.status === "FAIL") removalPass = false;
    }

    console.log("\n=== DB CONVERGENCE ===");
    console.log(`  t0 (tx committed):      ${new Date(t0).toISOString()}`);
    console.log(`  t1 (first empty read):  ${new Date(t1).toISOString()}`);
    const dbMs = t1 - t0;
    console.log(`  Elapsed: ${dbMs} ms  (budget 5000 ms → ${dbMs <= 5000 ? "PASS" : "FAIL"})`);

    const redisUrl = process.env["UPSTASH_REDIS_REST_URL"];
    const redisToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
    if (!redisUrl || !redisToken) {
      console.log("\n=== REDIS CONVERGENCE: NOT TAKEN ===");
      console.log("  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set in environment.");
      console.log("  Configure Redis and re-run to obtain a real measurement.");
    } else {
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({ url: redisUrl, token: redisToken });
      const sessionKey = `user:session:${MEM_USER_ID}`;
      await redis.set(sessionKey, JSON.stringify({ userId: MEM_USER_ID }), { ex: 30 });
      const rT0 = Date.now();
      await redis.del(sessionKey);
      let hit: unknown = await redis.get(sessionKey);
      let polls = 0;
      while (hit !== null && polls < 200) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        hit = await redis.get(sessionKey);
        polls++;
      }
      const redisMs = Date.now() - rT0;
      const redisPass = hit === null && redisMs <= 5000;
      console.log(`\n=== REDIS CONVERGENCE ===`);
      console.log(`  Elapsed: ${redisMs} ms  (budget 5000 ms → ${redisPass ? "PASS" : "FAIL"})`);
      if (hit !== null) console.log("  WARNING: session key still present after 200 polls × 50 ms");
    }

    const [reRow] = await runInNewTenantTransaction(db, ORG_ID, async (tx) =>
      tx
        .insert(organizationMembers)
        .values({ userId: MEM_USER_ID, orgId: ORG_ID, role: "MEMBER", status: "ACTIVE", isOwner: false })
        .returning({ id: organizationMembers.id }),
    );
    if (!reRow) throw new Error("re-invite insert failed");

    const reCounts = await snapshot(db, ORG_ID, reRow.id, MEM_USER_ID, MEM_EMAIL);
    let inheritancePass = true;
    console.log("\n=== RE-INVITE: NO INHERITANCE (each should be 0) ===");
    for (const [table, ct] of Object.entries(reCounts)) {
      const pass = ct === 0;
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${table.padEnd(30)} count=${ct}`);
      if (!pass) inheritancePass = false;
    }

    const driftPass = await checkArtifactFkDrift(db);

    console.log(`\n=== SUMMARY ===`);
    console.log(`  Removal artifacts: ${removalPass ? "PASS" : "FAIL"}`);
    console.log(`  No inheritance:    ${inheritancePass ? "PASS" : "FAIL"}`);
    console.log(`  Inventory vs FKs:  ${driftPass ? "PASS" : "FAIL"}`);

    process.exitCode = removalPass && inheritancePass && driftPass ? 0 : 1;
  } finally {
    try {
      if (orgSeeded) {
        await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
          await tx.delete(organizations).where(eq(organizations.id, ORG_ID));
        });
      }
    } catch (err: unknown) {
      console.error("org cleanup error:", err);
    }
    try {
      if (usersSeeded) {
        await db.delete(users).where(or(eq(users.id, MEM_USER_ID), eq(users.id, DEL_USER_ID)));
      }
    } catch (err: unknown) {
      console.error("users cleanup error:", err);
    }
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
