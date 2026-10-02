jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));
jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { EntitlementsService } from "./entitlements.service";
import { UserModuleAccessService } from "./user-module-access.service";
import { AccessVersionCache } from "./access-version-cache";
import { MANAGEABLE_MODULE_SET } from "./access-policy";

const MODULE = [...MANAGEABLE_MODULE_SET][0] ?? "hr";

function makeService(member: { id: number; userId: string; status: string; role?: string; isOwner?: boolean } | undefined) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const db = {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(member) } },
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate }) }),
  } as unknown as Db;
  const svc = new UserModuleAccessService(
    db,
    stubService<EntitlementsService>({ isCoreModule: jest.fn().mockReturnValue(false) }),
    stubService<CacheService>({}),
    stubService<AccessVersionCache>({ getVersion: jest.fn().mockResolvedValue(1) }),
  );
  jest.spyOn(svc, "getUserModuleAccess").mockResolvedValue([]);
  return { svc, db, onConflictDoUpdate };
}

describe("per-member module access changes commit with an audit row", () => {
  beforeEach(() => jest.mocked(commitAccessChange).mockClear());

  it("audits disabling a module for a member, attributed to the acting admin, inside the same transaction", async () => {
    const { svc, db, onConflictDoUpdate } = makeService({ id: 9, userId: "member-1", status: "ACTIVE" });

    await svc.setUserModuleAccess("org-1", "member-1", MODULE, false, "admin-1");

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(commitAccessChange).toHaveBeenCalledWith(
      db,
      "org-1",
      expect.objectContaining({
        audit: expect.objectContaining({
          action: "module_access.user_disabled",
          userId: "admin-1",
          targetId: "member-1",
          resourceId: MODULE,
          metadata: { moduleKey: MODULE, enabled: false, membershipId: 9 },
        }),
        revoke: expect.objectContaining({ loses: [{ kind: "permissions", userIds: ["member-1"] }] }),
      }),
    );
  });

  it("records an enable as module_access.user_enabled", async () => {
    const { svc } = makeService({ id: 9, userId: "member-1", status: "ACTIVE" });

    await svc.setUserModuleAccess("org-1", "member-1", MODULE, true, "admin-1");

    expect(jest.mocked(commitAccessChange).mock.calls[0]?.[2]).toMatchObject({
      audit: { action: "module_access.user_enabled" },
    });
  });

  it("writes and audits nothing for a non-member", async () => {
    const { svc, onConflictDoUpdate } = makeService(undefined);

    await expect(
      svc.setUserModuleAccess("org-1", "stranger", MODULE, false, "admin-1"),
    ).rejects.toThrow("not a member");

    expect(onConflictDoUpdate).not.toHaveBeenCalled();
    expect(commitAccessChange).not.toHaveBeenCalled();
  });

  it.each([
    { role: "OWNER", isOwner: true },
    { role: "ORG_ADMIN", isOwner: false },
  ])("rejects ineffective denial for structural $role standing", async ({ role, isOwner }) => {
    const { svc, onConflictDoUpdate } = makeService({
      id: 9,
      userId: "structural-admin",
      status: "ACTIVE",
      role,
      isOwner,
    });

    await expect(
      svc.setUserModuleAccess("org-1", "structural-admin", MODULE, false, "admin-1"),
    ).rejects.toThrow("Organization Owner and Admin access cannot be disabled per member");

    expect(onConflictDoUpdate).not.toHaveBeenCalled();
    expect(commitAccessChange).not.toHaveBeenCalled();
  });
});
