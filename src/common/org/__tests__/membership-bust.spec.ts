jest.mock("../../auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn(),
  bustMembershipStatusCacheMany: jest.fn(),
}));

import { scheduleMembershipBust, scheduleMembershipBustMany } from "../membership-bust";
import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../../auth/membership-state.service";
import { runWithTenantContext } from "../../tenant/tenant-context";
import type { AfterCommitHook } from "../../tenant/tenant-context";
import type { CacheService } from "../../cache/cache.service";

const mockCache = {} as CacheService;

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined);
  jest.mocked(bustMembershipStatusCacheMany).mockResolvedValue(undefined);
});

describe("scheduleMembershipBust", () => {
  it("calls bustMembershipStatusCache inline when there is no ambient context", async () => {
    await scheduleMembershipBust(mockCache, "user-1", "org-1");

    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(mockCache, "user-1", "org-1");
  });

  // An omitted orgId must stay omitted, not become an explicit undefined third
  // argument — callers' specs assert the two-argument call shape.
  it("omits orgId entirely when the caller does not supply one", async () => {
    await scheduleMembershipBust(mockCache, "user-2");

    expect(bustMembershipStatusCache).toHaveBeenCalledWith(mockCache, "user-2");
  });

  /**
   * This is the coupling test — the one that genuinely bites.
   *
   * Removing `registerAfterCommit(work)` from `scheduleMembershipBust` causes
   * the bust to run immediately (before the hooks array is inspected), so the
   * `not.toHaveBeenCalled()` assertion below fails.
   *
   * Removing the bust call entirely means `bustMembershipStatusCache` is never
   * called, so the final `toHaveBeenCalledWith` after hook drain fails.
   */
  it("defers the bust to after-commit hooks when an ambient context exists, and does not call it immediately", async () => {
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => scheduleMembershipBust(mockCache, "user-1", "org-1"),
    );

    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(mockCache, "user-1", "org-1");
  });

  it("does not register a hook when context is absent, and completes synchronously within the await", async () => {
    const hooks: AfterCommitHook[] = [];
    await scheduleMembershipBust(mockCache, "user-3", "org-2");
    expect(hooks).toHaveLength(0);
    expect(bustMembershipStatusCache).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleMembershipBustMany", () => {
  it("calls bustMembershipStatusCacheMany inline when there is no ambient context", async () => {
    await scheduleMembershipBustMany(mockCache, ["user-1", "user-2"]);

    expect(bustMembershipStatusCacheMany).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(mockCache, ["user-1", "user-2"]);
  });

  it("does not call the underlying bust for an empty list", async () => {
    await scheduleMembershipBustMany(mockCache, []);

    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();
  });

  it("defers the bust to after-commit hooks when an ambient context exists", async () => {
    const hooks: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
      () => scheduleMembershipBustMany(mockCache, ["user-1", "user-2"]),
    );

    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    for (const hook of hooks) await hook();

    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(mockCache, [
      "user-1",
      "user-2",
    ]);
  });
});
