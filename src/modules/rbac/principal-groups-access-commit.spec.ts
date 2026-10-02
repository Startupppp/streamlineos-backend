jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));
jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./assert-role-assignment", () => ({
  assertMayAssignRole: jest.fn().mockResolvedValue(undefined),
}));

import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";
import { PrincipalGroupsService } from "./principal-groups.service";

const actor: CurrentUserContext = {
  orgId: "org-1",
  userId: "admin-1",
  role: "ORG_ADMIN",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeService() {
  const writes = {
    values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
    where: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    query: {
      principalGroups: { findFirst: jest.fn().mockResolvedValue({ id: "grp-1", kind: "CUSTOM" }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      roles: { findFirst: jest.fn().mockResolvedValue({ id: 3, rank: 10, moduleKey: "hr" }) },
    },
    insert: jest.fn().mockReturnValue({ values: writes.values }),
    delete: jest.fn().mockReturnValue({ where: writes.where }),
  } as unknown as Db;
  const cache = { invalidate: jest.fn() };
  return { svc: new PrincipalGroupsService(db, {} as never, cache as never), db, cache };
}

function committedIntent() {
  const calls = jest.mocked(commitAccessChange).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]?.[2];
}

describe("principal group membership and role changes commit with an audit row", () => {
  beforeEach(() => jest.mocked(commitAccessChange).mockClear());

  it("audits adding a member and revokes that membership's cached access", async () => {
    const { svc, db, cache } = makeService();

    await svc.addMember(actor, "grp-1", { membershipId: 7 });

    expect(commitAccessChange).toHaveBeenCalledWith(db, "org-1", expect.anything());
    expect(committedIntent()).toMatchObject({
      audit: {
        action: "principal_group.member_added",
        userId: "admin-1",
        targetId: "grp-1",
        targetType: "principal_group",
        metadata: { membershipId: 7 },
      },
      revoke: { cache, loses: [{ kind: "memberships", membershipIds: [7] }] },
    });
  });

  it("audits removing a member", async () => {
    const { svc } = makeService();

    await svc.removeMember(actor, "grp-1", 7);

    expect(committedIntent()).toMatchObject({
      audit: { action: "principal_group.member_removed", metadata: { membershipId: 7 } },
      revoke: { loses: [{ kind: "memberships", membershipIds: [7] }] },
    });
  });

  it("audits assigning a role and revokes every group member", async () => {
    const { svc } = makeService();

    await svc.assignRole(actor, "grp-1", { roleId: 3 });

    expect(committedIntent()).toMatchObject({
      audit: { action: "principal_group.role_assigned", metadata: { roleId: 3 } },
      revoke: { loses: [{ kind: "group-members", groupId: "grp-1" }] },
    });
  });

  it("audits unassigning a role", async () => {
    const { svc } = makeService();

    await svc.unassignRole(actor, "grp-1", 3);

    expect(committedIntent()).toMatchObject({
      audit: { action: "principal_group.role_unassigned", metadata: { roleId: 3 } },
      revoke: { loses: [{ kind: "group-members", groupId: "grp-1" }] },
    });
  });
});
