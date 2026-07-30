import { syncStructuralRoleAssignment } from "./sync-structural-role";
import { ORG_MEMBER_ROLES } from "./org-roles";
import type { DbOrTx } from "./access-invalidate";

const ORG = "org-1";
const MEMBERSHIP = 42;
const ADMIN_ROLE_ID = 7;

type Captured = {
  inserted: unknown[];
  deleted: boolean;
  versionBumped: boolean;
};

function makeTx(adminRoleRows: Array<{ id: number }>): { tx: DbOrTx; captured: Captured } {
  const captured: Captured = { inserted: [], deleted: false, versionBumped: false };

  const selectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(adminRoleRows),
  };

  const tx = {
    select: jest.fn().mockReturnValue(selectChain),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: unknown) => {
        captured.inserted.push(v);
        return {
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: jest.fn().mockImplementation(() => {
            captured.versionBumped = true;
            return Promise.resolve(undefined);
          }),
        };
      }),
    })),
    delete: jest.fn().mockImplementation(() => ({
      where: jest.fn().mockImplementation(() => {
        captured.deleted = true;
        return Promise.resolve(undefined);
      }),
    })),
  } as unknown as DbOrTx;

  return { tx, captured };
}

describe("syncStructuralRoleAssignment", () => {
  it("creates the role_assignments row when a membership becomes ORG_ADMIN", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    const assignment = captured.inserted.find(
      (v): v is { roleId: number; organizationMembershipId: number; orgId: string } =>
        typeof v === "object" && v !== null && "roleId" in v,
    );
    expect(assignment).toBeDefined();
    expect(assignment?.roleId).toBe(ADMIN_ROLE_ID);
    expect(assignment?.organizationMembershipId).toBe(MEMBERSHIP);
    expect(assignment?.orgId).toBe(ORG);
    expect(captured.deleted).toBe(false);
  });

  it("bumps the permissions version so the access cache cannot serve a stale answer", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured.versionBumped).toBe(true);
  });

  it("removes the assignment when a member is demoted from ORG_ADMIN to MEMBER", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    expect(captured.deleted).toBe(true);
    const assignment = captured.inserted.find(
      (v) => typeof v === "object" && v !== null && "roleId" in v,
    );
    expect(assignment).toBeUndefined();
  });

  it("does not grant the admin role to a plain MEMBER", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    expect(
      captured.inserted.some((v) => typeof v === "object" && v !== null && "roleId" in v),
    ).toBe(false);
  });

  it("is a no-op when the org has no seeded ORG_ADMIN role", async () => {
    const { tx, captured } = makeTx([]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured.inserted).toHaveLength(0);
    expect(captured.deleted).toBe(false);
    expect(captured.versionBumped).toBe(false);
  });
});
