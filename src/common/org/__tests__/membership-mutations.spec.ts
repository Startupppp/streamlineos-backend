jest.mock("../../auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn(),
  bustMembershipStatusCacheMany: jest.fn(),
}));
jest.mock("../../rbac/access-mutation-commit", () => ({
  ...jest.requireActual<typeof import("../../rbac/access-mutation-commit")>(
    "../../rbac/access-mutation-commit",
  ),
  commitAccessChange: jest.fn(),
}));
jest.mock("../../rbac/sync-structural-role", () => ({
  syncStructuralRoleAssignment: jest.fn(),
  syncStructuralRoleAssignments: jest.fn(),
}));

import { drizzle } from "drizzle-orm/pg-proxy";
import {
  MembershipMutations,
  withMembershipMutations,
} from "../membership-mutations";
import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../../auth/membership-state.service";
import {
  commitAccessChange,
  scheduleStandingRevocation,
} from "../../rbac/access-mutation-commit";
import {
  syncStructuralRoleAssignment,
  syncStructuralRoleAssignments,
} from "../../rbac/sync-structural-role";
import { runWithTenantContext } from "../../tenant/tenant-context";
import type { AfterCommitHook } from "../../tenant/tenant-context";
import type { DbOrTx } from "../../rbac/access-mutation-commit";
import type { CacheService } from "../../cache/cache.service";
import { CACHE_KEYS } from "../../cache/cache-keys";

const ORG = "org-1";
const USER = "user-1";

type Statement = { sql: string; params: unknown[] };

function makeTx(returned: unknown[][] = [[42]]): {
  tx: DbOrTx;
  captured: Statement[];
} {
  const captured: Statement[] = [];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    return { rows: sql.includes("returning") ? returned : [] };
  });
  return { tx: db as unknown as DbOrTx, captured };
}

function makeCache(): CacheService {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateMany: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

function statementsOn(captured: Statement[], fragment: string): Statement[] {
  return captured.filter((statement) => statement.sql.includes(fragment));
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined);
  jest.mocked(bustMembershipStatusCacheMany).mockResolvedValue(undefined);
  jest.mocked(commitAccessChange).mockResolvedValue(undefined);
  jest.mocked(syncStructuralRoleAssignment).mockResolvedValue(undefined);
  jest.mocked(syncStructuralRoleAssignments).mockResolvedValue(undefined);
});

describe("createMembership", () => {
  it("writes the row, syncs the structural role and drains one bust from a single call", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    const membershipId = await withMembershipMutations((membership) =>
      membership.createMembership(tx, { orgId: ORG, userId: USER, role: "MEMBER" }),
    );

    expect(membershipId).toBe(42);
    const inserts = statementsOn(captured, 'insert into "organization_members"');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual(expect.arrayContaining([ORG, USER, "MEMBER"]));
    expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(tx, ORG, 42, "MEMBER");
    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("skips the conflict, returns null and does not sync a role that was never granted", async () => {
    const { tx, captured } = makeTx([]);
    const cache = makeCache();

    const membershipId = await withMembershipMutations((membership) =>
      membership.createMembership(tx, {
        orgId: ORG,
        userId: USER,
        role: "MEMBER",
        onConflict: "skip",
      }),
    );

    expect(membershipId).toBeNull();
    expect(statementsOn(captured, "on conflict do nothing")).toHaveLength(1);
    expect(syncStructuralRoleAssignment).not.toHaveBeenCalled();
    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
  });
});

describe("createOwnerMembership", () => {
  it("writes an owner row at a preallocated id and drains its bust", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.createOwnerMembership(tx, {
        orgId: ORG,
        userId: USER,
        membershipId: 7,
        role: "OWNER",
      }),
    );

    const inserts = statementsOn(captured, 'insert into "organization_members"');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual(expect.arrayContaining([7, ORG, USER, "OWNER", true]));
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("refuses an allocation that did not return an integer id", async () => {
    const { tx } = makeTx([]);
    const mutations = new MembershipMutations();

    await expect(mutations.allocateMembershipId(tx)).rejects.toThrow(
      "Failed to allocate owner membership id",
    );
  });

  it("returns the allocated sequence value", async () => {
    const execute = jest.fn().mockResolvedValue([{ id: "912" }]);
    const tx = { execute } as unknown as DbOrTx;

    await expect(new MembershipMutations().allocateMembershipId(tx)).resolves.toBe(912);
  });
});

describe("changeRole", () => {
  it("updates the role, syncs the assignment and drains one bust", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.changeRole(tx, { orgId: ORG, userId: USER, role: "ORG_ADMIN" }),
    );

    const updates = statementsOn(captured, 'update "organization_members"');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual(expect.arrayContaining(["ORG_ADMIN", ORG, USER]));
    expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(tx, ORG, 42, "ORG_ADMIN", undefined);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("hands the caller's audit, revoke and notify intents to the structural sync's single commit", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const access = {
      audit: { action: "org.member_role_changed", userId: "actor" },
      revoke: { cache, loses: [{ kind: "standing" as const, userIds: [USER] }] },
    };

    await withMembershipMutations((membership) =>
      membership.changeRole(tx, { orgId: ORG, userId: USER, role: "ORG_ADMIN" }, access),
    );

    expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(tx, ORG, 42, "ORG_ADMIN", access);
    expect(commitAccessChange).not.toHaveBeenCalled();
  });

  it("hands a bulk role change's intents to the batched sync", async () => {
    const { tx } = makeTx([[1], [2]]);
    const cache = makeCache();
    const access = { audit: { action: "user.bulk_updated", userId: "actor" } };

    await withMembershipMutations((membership) =>
      membership.changeRoles(tx, { orgId: ORG, userIds: ["a", "b"], role: "MEMBER" }, access),
    );

    expect(syncStructuralRoleAssignments).toHaveBeenCalledWith(tx, ORG, [1, 2], "MEMBER", access);
  });
});

describe("setLifecycleStatus", () => {
  it("suspends the row, stamps suspended_at, bumps the version and busts", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();
    const occurredAt = new Date("2026-09-10T00:00:00.000Z");

    await withMembershipMutations((membership) =>
      membership.setLifecycleStatus(tx, {
        orgId: ORG,
        userId: USER,
        status: "SUSPENDED",
        occurredAt,
      }),
    );

    const updates = statementsOn(captured, 'update "organization_members"');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain('"suspended_at"');
    expect(updates[0]?.sql).toContain('"left_at"');
    expect(updates[0]?.params).toEqual([
      "SUSPENDED",
      occurredAt.toISOString(),
      null,
      USER,
      ORG,
    ]);
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, undefined);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("commits the status change once, carrying the caller's intents", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const access = { audit: { action: "org.member_suspended", userId: "actor" } };

    await withMembershipMutations((membership) =>
      membership.setLifecycleStatus(
        tx,
        { orgId: ORG, userId: USER, status: "SUSPENDED", occurredAt: new Date() },
        access,
      ),
    );

    expect(commitAccessChange).toHaveBeenCalledTimes(1);
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, access);
  });

  it("reactivation stamps activated_at and clears both tombstones", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();
    const occurredAt = new Date("2026-09-10T00:00:00.000Z");

    await withMembershipMutations((membership) =>
      membership.setLifecycleStatus(tx, {
        orgId: ORG,
        userId: USER,
        status: "ACTIVE",
        occurredAt,
      }),
    );

    const update = statementsOn(captured, 'update "organization_members"')[0];
    expect(update?.sql).toContain('"activated_at"');
    expect(update?.sql).toContain('"suspended_at"');
    expect(update?.sql).toContain('"left_at"');
    expect(update?.params).toEqual([
      "ACTIVE",
      occurredAt.toISOString(),
      null,
      null,
      USER,
      ORG,
    ]);
  });
});

describe("deleteMembership", () => {
  it("deletes the row, bumps the version and busts", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.deleteMembership(tx, { orgId: ORG, userId: USER }),
    );

    expect(statementsOn(captured, 'delete from "organization_members"')).toHaveLength(1);
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, undefined);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("commits the removal once, after the delete, carrying the caller's intents", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();
    const access = { audit: { action: "org.member_removed", userId: "actor" } };
    (commitAccessChange as jest.Mock).mockImplementationOnce(() => {
      expect(statementsOn(captured, 'delete from "organization_members"')).toHaveLength(1);
      return Promise.resolve();
    });

    await withMembershipMutations((membership) =>
      membership.deleteMembership(tx, { orgId: ORG, userId: USER }, access),
    );

    expect(commitAccessChange).toHaveBeenCalledTimes(1);
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, access);
  });

  it("deleteMembershipsById scopes to the organisation and does not bump the version", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.deleteMembershipsById(tx, {
        orgId: ORG,
        userId: USER,
        membershipIds: [3, 4],
      }),
    );

    const deletes = statementsOn(captured, 'delete from "organization_members"');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toEqual(expect.arrayContaining([ORG, 3, 4]));
    expect(commitAccessChange).not.toHaveBeenCalled();
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });
});

describe("transferOrgOwnership", () => {
  it("demotes, promotes and busts both members in one batched command", async () => {
    const { tx, captured } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.transferOrgOwnership(tx, {
        orgId: ORG,
        from: { membershipId: 1, userId: "user-from" },
        to: { membershipId: 2, userId: "user-to" },
        demotedRole: "ORG_ADMIN",
        ownerRole: "OWNER",
      }),
    );

    const updates = statementsOn(captured, 'update "organization_members"');
    expect(updates).toHaveLength(2);
    expect(updates[0]?.params).toEqual(expect.arrayContaining([false, "ORG_ADMIN", 1]));
    expect(updates[1]?.params).toEqual(expect.arrayContaining([true, "OWNER", "ACTIVE", 2]));
    expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(tx, ORG, 1, "ORG_ADMIN");
    // Both sides change role. Only the demoted one used to be re-synced, so the promoted owner
    // kept the `role_assignments` row of the role they no longer hold and the role-members view
    // still listed them under it.
    expect(syncStructuralRoleAssignment).toHaveBeenCalledWith(tx, ORG, 2, "OWNER");
    expect(syncStructuralRoleAssignment).toHaveBeenCalledTimes(2);
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(cache, [
      "user-from",
      "user-to",
    ]);
  });
});

describe("bulk operations are bounded", () => {
  it("issues one batched command for a bulk create regardless of member count", async () => {
    const size = 250;
    const members = Array.from({ length: size }, (_, index) => ({
      userId: `bulk-user-${index}`,
      role: "MEMBER",
    }));
    const { tx, captured } = makeTx(
      members.map((member, index) => [index + 1, member.userId]),
    );
    const cache = makeCache();

    const byUserId = await withMembershipMutations((membership) =>
      membership.createMemberships(tx, { orgId: ORG, members }),
    );

    expect(byUserId.size).toBe(size);
    expect(statementsOn(captured, 'insert into "organization_members"')).toHaveLength(1);
    expect(syncStructuralRoleAssignments).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(jest.mocked(bustMembershipStatusCacheMany).mock.calls[0]?.[1]).toHaveLength(size);
  });

  it("groups the structural role sync by role rather than per member", async () => {
    const members = [
      { userId: "u-1", role: "MEMBER" },
      { userId: "u-2", role: "ORG_ADMIN" },
      { userId: "u-3", role: "MEMBER" },
    ];
    const { tx } = makeTx(members.map((member, index) => [index + 1, member.userId]));

    await withMembershipMutations(makeCache(), (membership) =>
      membership.createMemberships(tx, { orgId: ORG, members }),
    );

    expect(syncStructuralRoleAssignments).toHaveBeenCalledTimes(2);
    expect(syncStructuralRoleAssignments).toHaveBeenCalledWith(tx, ORG, [1, 3], "MEMBER");
    expect(syncStructuralRoleAssignments).toHaveBeenCalledWith(tx, ORG, [2], "ORG_ADMIN");
  });

  it("issues one batched command for a bulk role change", async () => {
    const userIds = Array.from({ length: 120 }, (_, index) => `role-user-${index}`);
    const { tx, captured } = makeTx(userIds.map((_, index) => [index + 1]));
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.changeRoles(tx, { orgId: ORG, userIds, role: "MEMBER" }),
    );

    expect(statementsOn(captured, 'update "organization_members"')).toHaveLength(1);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });

  it("a whole-org teardown bust is one command for any roster size", async () => {
    const cache = makeCache();
    const userIds = Array.from({ length: 5000 }, (_, index) => `member-${index}`);

    await scheduleStandingRevocation(cache, userIds);

    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });
});

describe("transaction coupling", () => {
  it("drains nothing when the transaction call rejects", async () => {
    const { tx } = makeTx();
    const cache = makeCache();

    await expect(
      withMembershipMutations(async (membership) => {
        await membership.createMembership(tx, { orgId: ORG, userId: USER, role: "MEMBER" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();
  });

  it("defers the drain to after-commit when an ambient request transaction exists", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () =>
        withMembershipMutations((membership) =>
          membership.createMembership(tx, { orgId: ORG, userId: USER, role: "MEMBER" }),
        ),
    );

    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });

  it("falls back to an inline bust outside an ambient transaction", async () => {
    const { tx } = makeTx();
    const cache = makeCache();

    await withMembershipMutations((membership) =>
      membership.createMembership(tx, { orgId: ORG, userId: USER, role: "MEMBER" }),
    );

    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
  });
});

describe("invalidation-only entry points", () => {
  it("membership revocation busts status and session only after commit so no pre-commit read can refill a stale entry", async () => {
    const cache = makeCache();
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => scheduleStandingRevocation(cache, [USER], { withSessions: true }),
    );

    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession(USER));
  });

  it("identity erasure busts every organisation the subject belongs to", async () => {
    const cache = makeCache();

    await scheduleStandingRevocation(cache, [USER]);

    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, USER);
  });
});
