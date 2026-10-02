import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessFlatMembersService } from "../module-access-flat-members.service";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { userModuleAccess } from "../../../db/schema";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";

jest.mock("../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-1";
const ACTOR = "u-owner";
const TARGET = "u-member";
const MEMBERSHIP_ID = 7;
const MODULE = "build";

async function makeService(
  target: { id: number; role: string; isOwner: boolean; status: string },
  roleRows: Array<{ id: number }> = [],
) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({
    onConflictDoUpdate,
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  });
  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockReturnValue({ values }),
    delete: jest.fn(),
  };
  const db = {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(target) } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(roleRows) }),
    }),
    transaction: jest.fn().mockImplementation(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const cache = { invalidate: jest.fn(), invalidateNamespace: jest.fn() };
  const module = await Test.createTestingModule({
    providers: [
      ModuleAccessFlatMembersService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: AccessService, useValue: { isModuleEnabled: jest.fn().mockResolvedValue(true) } },
      { provide: ModuleAccessGroupPolicyService, useValue: { resolveOwnerUserId: jest.fn().mockResolvedValue(null) } },
    ],
  }).compile();
  return { service: module.get(ModuleAccessFlatMembersService), tx, db, values, onConflictDoUpdate };
}

const actor: CurrentUserContext = {
  userId: ACTOR,
  orgId: ORG,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

describe("flat Build member revocation", () => {
  beforeEach(() => jest.mocked(commitAccessChange).mockClear());

  it("denies surviving indirect grants even when the member has no direct module role", async () => {
    const { service, tx, db, values, onConflictDoUpdate } = await makeService({
      id: MEMBERSHIP_ID,
      role: "MEMBER",
      isOwner: false,
      status: "ACTIVE",
    });

    await expect(service.removeMember(actor, MODULE, TARGET)).resolves.toEqual({ success: true });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledWith(userModuleAccess);
    expect(values).toHaveBeenCalledWith({
      orgId: ORG,
      organizationMembershipId: MEMBERSHIP_ID,
      moduleKey: MODULE,
      enabled: false,
      updatedBy: ACTOR,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, expect.objectContaining({
      audit: expect.objectContaining({ action: "module_access.member_removed" }),
      revoke: expect.objectContaining({ loses: [{ kind: "permissions", userIds: [TARGET] }] }),
    }));
  });

  it("preserves structural Org Admin Build access", async () => {
    const { service, tx, db } = await makeService({
      id: MEMBERSHIP_ID,
      role: "ORG_ADMIN",
      isOwner: false,
      status: "ACTIVE",
    });

    await expect(service.removeMember(actor, MODULE, TARGET)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("repeating removal upserts one membership-scoped denial rather than skipping the revoke", async () => {
    const { service, onConflictDoUpdate, db } = await makeService({
      id: MEMBERSHIP_ID,
      role: "MEMBER",
      isOwner: false,
      status: "ACTIVE",
    });

    await service.removeMember(actor, MODULE, TARGET);
    await service.removeMember(actor, MODULE, TARGET);

    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    expect(commitAccessChange).toHaveBeenCalledTimes(2);
  });

  it("an explicit member regrant clears the deny in the same access transaction", async () => {
    const { service, values, tx } = await makeService({
      id: MEMBERSHIP_ID,
      role: "MEMBER",
      isOwner: false,
      status: "ACTIVE",
    }, [{ id: 42 }]);

    await expect(service.addMember(actor, MODULE, { userId: TARGET, groupIds: [42] }))
      .resolves.toEqual({ success: true });

    expect(values).toHaveBeenCalledWith({
      orgId: ORG,
      organizationMembershipId: MEMBERSHIP_ID,
      moduleKey: MODULE,
      enabled: true,
      updatedBy: ACTOR,
    });
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG, expect.objectContaining({
      audit: expect.objectContaining({ action: "module_access.member_added" }),
    }));
  });

  it("rejects an empty group replacement and directs callers to full removal", async () => {
    const { service, db, values } = await makeService({
      id: MEMBERSHIP_ID,
      role: "MEMBER",
      isOwner: false,
      status: "ACTIVE",
    });

    await expect(service.updateMemberGroups(actor, MODULE, TARGET, { groupIds: [] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });
});
