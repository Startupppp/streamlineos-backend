import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DASHBOARD_LEAVE_BALANCE_NAMESPACE,
  DASHBOARD_PENDING_APPROVALS_NAMESPACE,
} from "../../common/cache/cache-keys";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AccessService } from "../access/access.service";
import type { Db } from "../../db/drizzle.module";
import { DashboardLeaveService } from "./dashboard-leave.service";
import { LeaveDecisionEffectsService } from "../hr/time/leave-decision-effects.service";

const ORG = "org-1";
const DASHBOARD_DIR = __dirname;

const ORG_SCOPED_CACHE_METHODS = [
  "cachedForOrg",
  "cachedForOrgWith",
  "cachedVersionedForOrg",
  "invalidateForOrg",
  "invalidateNamespaceForOrg",
  "orgScopedKey",
];

function user(userId: string, membershipId: number): CurrentUserContext {
  return {
    userId,
    orgId: ORG,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

function access(scope: string, holds: boolean, version = 3): AccessService {
  return {
    scopeFor: jest.fn().mockResolvedValue(scope),
    holds: jest.fn().mockResolvedValue(holds),
    getPermissionsVersion: jest.fn().mockResolvedValue(version),
  } as unknown as AccessService;
}

interface RecordedCall {
  method: string;
  orgId: string;
  key: string;
}

function recordingCache() {
  const calls: RecordedCall[] = [];
  const globalCached = jest.fn();
  const globalInvalidate = jest.fn();
  const cache = {
    cached: globalCached,
    cachedVersioned: globalCached,
    invalidate: globalInvalidate,
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    cachedForOrg: jest
      .fn()
      .mockImplementation((orgId: string, key: string) => {
        calls.push({ method: "cachedForOrg", orgId, key });
        return Promise.resolve([]);
      }),
    cachedVersionedForOrg: jest
      .fn()
      .mockImplementation((orgId: string, ns: string, key: string) => {
        calls.push({ method: "cachedVersionedForOrg", orgId, key: `${ns}|${key}` });
        return Promise.resolve({});
      }),
    invalidateNamespaceForOrg: jest
      .fn()
      .mockImplementation((orgId: string, ns: string) => {
        calls.push({ method: "invalidateNamespaceForOrg", orgId, key: ns });
        return Promise.resolve(undefined);
      }),
  };
  return { calls, globalCached, globalInvalidate, cache };
}

/**
 * `cached`/`invalidate` resolve the DEFAULT Redis and an unprefixed key; the
 * `*ForOrg` family resolves the org's own cell and prefixes it. A Home section
 * on the global family writes a tenant's data into another region's cache.
 */
describe("every Home cache entry is written through the org's own Redis cell", () => {
  const files = readdirSync(DASHBOARD_DIR).filter(
    (name) => name.endsWith(".service.ts") && !name.includes(".spec."),
  );

  it("scans a real corpus, so a clean result is not an unscanned one", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    const sites = files.flatMap((name) => [
      ...readFileSync(join(DASHBOARD_DIR, name), "utf8").matchAll(
        /this\.cache\.([A-Za-z]+)\(/g,
      ),
    ]);
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("has no dashboard service left on the global cache family", () => {
    const offenders: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(DASHBOARD_DIR, name), "utf8");
      for (const match of source.matchAll(/this\.cache\.([A-Za-z]+)\(/g)) {
        const method = match[1] ?? "";
        if (ORG_SCOPED_CACHE_METHODS.includes(method)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${name}:${String(line)} — this.cache.${method}(`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("DashboardLeaveService cache placement", () => {
  it("routes the personal leave balance through the org cell's versioned namespace, so an approval retires it instead of leaving a stale number for the TTL", async () => {
    const { calls, globalCached, cache } = recordingCache();
    const service = new DashboardLeaveService(
      {} as unknown as Db,
      cache as never,
      access("own", false),
    );

    await service.getMyLeaveBalance(user("u1", 1));

    expect(globalCached).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("cachedVersionedForOrg");
    expect(calls[0]?.orgId).toBe(ORG);
    expect(calls[0]?.key).toContain(DASHBOARD_LEAVE_BALANCE_NAMESPACE);
    expect(calls[0]?.key).toContain("leave-balance");
    expect(calls[0]?.key).toContain("u1");
  });

  it("keys one member's balance apart from another's", async () => {
    const a = recordingCache();
    const b = recordingCache();
    await new DashboardLeaveService(
      {} as unknown as Db,
      a.cache as never,
      access("own", false),
    ).getMyLeaveBalance(user("u1", 1));
    await new DashboardLeaveService(
      {} as unknown as Db,
      b.cache as never,
      access("own", false),
    ).getMyLeaveBalance(user("u2", 2));

    expect(a.calls[0]?.key).not.toBe(b.calls[0]?.key);
  });

  it("routes pending approvals through a per-org namespace generation", async () => {
    const { calls, globalCached, cache } = recordingCache();
    const service = new DashboardLeaveService(
      {} as unknown as Db,
      cache as never,
      access("all", true),
    );

    await service.getPendingApprovals(ORG, user("approver-1", 5));

    expect(globalCached).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("cachedVersionedForOrg");
    expect(calls[0]?.orgId).toBe(ORG);
    expect(calls[0]?.key).toContain(DASHBOARD_PENDING_APPROVALS_NAMESPACE);
    expect(calls[0]?.key).toContain("pending-approvals");
  });

  it("keys one approver's queue apart from another's", async () => {
    const a = recordingCache();
    const b = recordingCache();
    await new DashboardLeaveService(
      {} as unknown as Db,
      a.cache as never,
      access("team", true),
    ).getPendingApprovals(ORG, user("approver-1", 5));
    await new DashboardLeaveService(
      {} as unknown as Db,
      b.cache as never,
      access("team", true),
    ).getPendingApprovals(ORG, user("approver-2", 6));

    expect(a.calls[0]?.key).not.toBe(b.calls[0]?.key);
  });

  it("keys the approver and the self projection apart", async () => {
    const approver = recordingCache();
    const self = recordingCache();
    await new DashboardLeaveService(
      {} as unknown as Db,
      approver.cache as never,
      access("all", true),
    ).getPendingApprovals(ORG, user("u1", 5));
    await new DashboardLeaveService(
      {} as unknown as Db,
      self.cache as never,
      access("all", false),
    ).getPendingApprovals(ORG, user("u1", 5));

    expect(approver.calls[0]?.key).not.toBe(self.calls[0]?.key);
  });

  it("does not cache at all for a caller the scope denies", async () => {
    const { calls, cache } = recordingCache();
    const service = new DashboardLeaveService(
      {} as unknown as Db,
      cache as never,
      access("none", false),
    );

    const result = await service.getPendingApprovals(ORG, user("u1", 1));

    expect(result).toEqual({ error: "forbidden", message: "Forbidden" });
    expect(calls).toEqual([]);
  });
});

describe("a leave decision retires the Home approvals count", () => {
  function effects(cache: ReturnType<typeof recordingCache>["cache"]) {
    return new LeaveDecisionEffectsService(
      { emit: jest.fn().mockResolvedValue(undefined) } as never,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatch: jest.fn() } as never,
      { rebuildOpenPeriodForMonth: jest.fn().mockResolvedValue(undefined) } as never,
      cache as never,
    );
  }

  const decision = {
    userId: "u2",
    leaveTypeId: 1,
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  };

  it("bumps the pending-approvals generation on approval", async () => {
    const { calls, cache } = recordingCache();

    await effects(cache).afterApproved(user("approver-1", 5), 11, decision, undefined, 0);

    expect(calls).toContainEqual({
      method: "invalidateNamespaceForOrg",
      orgId: ORG,
      key: DASHBOARD_PENDING_APPROVALS_NAMESPACE,
    });
  });

  it("bumps it on rejection too, so a rejected request stops being counted", async () => {
    const { calls, cache } = recordingCache();

    await effects(cache).afterRejected(user("approver-1", 5), 11, decision, "no", undefined);

    expect(calls).toContainEqual({
      method: "invalidateNamespaceForOrg",
      orgId: ORG,
      key: DASHBOARD_PENDING_APPROVALS_NAMESPACE,
    });
  });

  it("bumps it when a decision is reverted back to pending", async () => {
    const { calls, cache } = recordingCache();

    await effects(cache).afterRevertedToPending(ORG, "approver-1", decision);

    expect(calls).toContainEqual({
      method: "invalidateNamespaceForOrg",
      orgId: ORG,
      key: DASHBOARD_PENDING_APPROVALS_NAMESPACE,
    });
  });
});
