jest.mock("../../auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn(),
  bustMembershipStatusCacheMany: jest.fn(),
}));

import {
  bustMembershipAfterIdentityErasure,
  bustMembershipsAfterOrgTeardown,
} from "../membership-bust";
import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../../auth/membership-state.service";
import { runWithTenantContext } from "../../tenant/tenant-context";
import type { AfterCommitHook } from "../../tenant/tenant-context";
import type { CacheService } from "../../cache/cache.service";

const mockCache = {
  invalidate: jest.fn(),
  invalidateMany: jest.fn(),
} as unknown as CacheService;

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined);
  jest.mocked(bustMembershipStatusCacheMany).mockResolvedValue(undefined);
});

describe("bustMembershipAfterIdentityErasure", () => {
  it("busts the subject's membership status inline when there is no ambient context", async () => {
    await bustMembershipAfterIdentityErasure(mockCache, "user-1");

    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(mockCache, "user-1");
  });

  it("defers the bust to after-commit hooks when an ambient context exists, and does not call it immediately", async () => {
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => bustMembershipAfterIdentityErasure(mockCache, "user-1"),
    );

    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCache).toHaveBeenCalledWith(mockCache, "user-1");
  });
});

describe("bustMembershipsAfterOrgTeardown", () => {
  it("busts every member in one batched call inline when there is no ambient context", async () => {
    await bustMembershipsAfterOrgTeardown(mockCache, ["user-1", "user-2"]);

    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(mockCache, ["user-1", "user-2"]);
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });

  it("does not schedule or call any bust for an empty member list", async () => {
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => bustMembershipsAfterOrgTeardown(mockCache, []),
    );

    expect(hooks).toHaveLength(0);
    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();
  });

  it("defers the batched bust to after-commit hooks when an ambient context exists", async () => {
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => bustMembershipsAfterOrgTeardown(mockCache, ["user-1", "user-2"]),
    );

    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(mockCache, ["user-1", "user-2"]);
  });
});
