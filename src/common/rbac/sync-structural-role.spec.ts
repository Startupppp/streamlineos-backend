import { syncStructuralRoleAssignment } from "./sync-structural-role";
import { ORG_MEMBER_ROLES } from "./org-roles";
import type { DbOrTx } from "./access-invalidate";

const ORG = "org-1";
const MEMBERSHIP = 42;
const ADMIN_ROLE_ID = 7;
const MEMBER_ROLE_ID = 9;

type Captured = {
  inserted: unknown[];
  deleted: boolean;
  versionBumped: boolean;
};

function makeTx(
  adminRoleRows: Array<{ id: number }>,
  memberRoleRows: Array<{ id: number }>,
): { tx: DbOrTx; captured: Captured } {
  const captured: Captured = { inserted: [], deleted: false, versionBumped: false };

  const makeSelectChain = (rows: Array<{ id: number }>) => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  });

  const tx = {
    select: jest
      .fn()
      .mockReturnValueOnce(makeSelectChain(adminRoleRows))
      .mockReturnValueOnce(makeSelectChain(memberRoleRows)),
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

function roleIdOf(v: unknown): number | undefined {
  if (typeof v === "object" && v !== null && "roleId" in v) {
    const roleId = (v as { roleId: unknown }).roleId;
    return typeof roleId === "number" ? roleId : undefined;
  }
  return undefined;
}

describe("syncStructuralRoleAssignment", () => {
  it("creates the ORG_ADMIN role_assignments row when a membership becomes ORG_ADMIN", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }], []);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    const assignment = captured.inserted.find(
      (v): v is { roleId: number; organizationMembershipId: number; orgId: string } =>
        roleIdOf(v) === ADMIN_ROLE_ID,
    );
    expect(assignment).toBeDefined();
    expect(assignment?.roleId).toBe(ADMIN_ROLE_ID);
    expect(assignment?.organizationMembershipId).toBe(MEMBERSHIP);
    expect(assignment?.orgId).toBe(ORG);
    expect(captured.deleted).toBe(false);
  });

  it("bumps the permissions version so the access cache cannot serve a stale answer", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }], []);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured.versionBumped).toBe(true);
  });

  it("assigns the MEMBER role and removes the ORG_ADMIN assignment when demoted", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }], [{ id: MEMBER_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    const memberAssignment = captured.inserted.find((v) => roleIdOf(v) === MEMBER_ROLE_ID);
    expect(memberAssignment).toBeDefined();
    expect(captured.deleted).toBe(true);
  });

  it("does not grant the ORG_ADMIN role to a plain MEMBER", async () => {
    const { tx, captured } = makeTx([{ id: ADMIN_ROLE_ID }], [{ id: MEMBER_ROLE_ID }]);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    expect(captured.inserted.some((v) => roleIdOf(v) === ADMIN_ROLE_ID)).toBe(false);
  });

  it("is a no-op when the org has no seeded structural roles", async () => {
    const { tx, captured } = makeTx([], []);

    await syncStructuralRoleAssignment(tx, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured.inserted).toHaveLength(0);
    expect(captured.deleted).toBe(false);
    expect(captured.versionBumped).toBe(false);
  });
});
