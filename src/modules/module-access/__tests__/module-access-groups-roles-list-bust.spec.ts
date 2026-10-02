jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));
jest.mock("../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

import { commitAccessChange } from "../../../common/rbac/access-mutation-commit";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { ModuleAccessGroupCrudService } from "../module-access-group-crud.service";

const owner: CurrentUserContext = {
  orgId: "org-1",
  userId: "owner-1",
  role: "MEMBER",
  isOrgOwner: true,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function makeService() {
  const assigned = { from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) };
  const db = {
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue({ id: 5, name: "Ops", isSystem: false }) },
    },
    select: jest.fn().mockReturnValue(assigned),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  } as unknown as Db;
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const svc = new ModuleAccessGroupCrudService(db, {} as never, cache as never, {} as never);
  return { svc, cache };
}

describe("module group writes bust the roles list through the commit, after commit", () => {
  beforeEach(() => jest.mocked(commitAccessChange).mockClear());

  it("deleteGroup hands the roles-list key to the commit instead of busting it before the transaction resolves", async () => {
    const { svc, cache } = makeService();

    await expect(svc.deleteGroup(owner, "hr", 5)).resolves.toEqual({ success: true });

    expect(commitAccessChange).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({
        audit: expect.objectContaining({ action: "module_access.group_deleted" }),
        revoke: expect.objectContaining({ cache, listKeys: [CACHE_KEYS.rolesList("org-1")] }),
      }),
    );
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});
