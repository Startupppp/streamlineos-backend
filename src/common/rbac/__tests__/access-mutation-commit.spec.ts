import {
  commitAccessChange,
  scheduleStandingRevocation,
  REVOCATION_PAGE_SIZE,
  type CommitAccessAudit,
  type DbOrTx,
} from "../access-mutation-commit";
import { bumpPermissionsVersion } from "../access-invalidate";
import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../../auth/membership-state.service";
import { getObservabilityContext } from "../../observability/observability-context";
import { getImpersonationContext } from "../../impersonation/impersonation-context";
import { runWithTenantContext, type AfterCommitHook } from "../../tenant/tenant-context";
import { runInTenantTransaction } from "../../tenant/run-in-tenant-transaction";
import { observeAfterCommitWork } from "../../observability/after-commit-work";
import { CACHE_KEYS } from "../../cache/cache-keys";
import { auditLogs, userSessions } from "../../../db/schema";
import type { CacheService } from "../../cache/cache.service";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn(),
}));

jest.mock("../../auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn(),
  bustMembershipStatusCacheMany: jest.fn(),
}));

jest.mock("../../observability/observability-context", () => ({
  ...jest.requireActual<typeof import("../../observability/observability-context")>(
    "../../observability/observability-context",
  ),
  getObservabilityContext: jest.fn(),
}));

jest.mock("../../impersonation/impersonation-context", () => ({
  getImpersonationContext: jest.fn(),
}));

jest.mock("../../tenant/with-tenant", () => ({
  withTenant: jest.fn(),
  withNewOrgInRegion: jest.fn(),
}));

import { withTenant } from "../../tenant/with-tenant";

const ORG = "org-commit-test";

interface FakeTx {
  tx: DbOrTx;
  inserted: { table: unknown; row: unknown }[];
  selects: jest.Mock;
  updates: jest.Mock;
}

function makeTx(selectResults: unknown[][] = [], updateReturning: unknown[] = []): FakeTx {
  const inserted: { table: unknown; row: unknown }[] = [];
  const queue = [...selectResults];
  const next = (): Promise<unknown[]> => Promise.resolve(queue.shift() ?? []);
  const selects = jest.fn(() => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => next(),
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
        next().then(resolve, reject),
    };
    return chain;
  });
  const updates = jest.fn(() => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(updateReturning) }) }),
  }));
  const fake = {
    select: selects,
    update: updates,
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: unknown) => {
        inserted.push({ table, row });
        return Promise.resolve();
      }),
    })),
  };
  return { tx: fake as unknown as DbOrTx, inserted, selects, updates };
}

function makeCache() {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateMany: jest.fn().mockResolvedValue(undefined),
  };
}

function asCache(cache: ReturnType<typeof makeCache>): CacheService {
  return cache as unknown as CacheService;
}

async function inRequest<T>(work: () => Promise<T>): Promise<{ hooks: AfterCommitHook[]; result: T }> {
  const hooks: AfterCommitHook[] = [];
  const result = await runWithTenantContext(
    { orgId: ORG, audience: "INTERNAL", tx: {} as never, afterCommit: hooks },
    work,
  );
  return { hooks, result };
}

async function drain(hooks: readonly AfterCommitHook[]): Promise<void> {
  for (const hook of hooks) await hook();
}

const memberRows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    membershipId: from + i,
    userId: `user-${String(from + i)}`,
  }));

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(bumpPermissionsVersion).mockResolvedValue(undefined);
  jest.mocked(bustMembershipStatusCache).mockResolvedValue(undefined);
  jest.mocked(bustMembershipStatusCacheMany).mockResolvedValue(undefined);
  jest.mocked(getObservabilityContext).mockReturnValue(undefined);
  jest.mocked(getImpersonationContext).mockReturnValue(undefined);
});

describe("commitAccessChange — version bump", () => {
  it("bumps on the supplied tx handle so the bump is atomic with the mutation", async () => {
    const { tx } = makeTx();
    const { tx: other } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
    expect(bumpPermissionsVersion).not.toHaveBeenCalledWith(other, ORG);
  });

  it("bumps exactly once with no intents so a bare access write still invalidates", async () => {
    const { tx, inserted } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });
});

describe("commitAccessChange — audit row", () => {
  it("writes the audit row into audit_logs on the same tx so it rolls back with the change", async () => {
    const { tx, inserted } = makeTx();
    const audit: CommitAccessAudit = { action: "test.committed", userId: "u-1" };
    await commitAccessChange(tx, ORG, { audit });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe(auditLogs);
    expect(inserted[0]?.row).toMatchObject({ action: "test.committed", userId: "u-1", orgId: ORG });
  });

  it("stores a system actor in metadata so machine principals are attributable", async () => {
    const { tx, inserted } = makeTx();
    await commitAccessChange(tx, ORG, { audit: { action: "system.action", systemActor: "seed" } });
    expect(inserted[0]?.row).toMatchObject({
      userId: null,
      metadata: expect.objectContaining({ systemActor: "seed" }),
    });
  });

  it("records the real actor under impersonation and omits the keys without it", async () => {
    jest.mocked(getImpersonationContext).mockReturnValueOnce({
      realActorUserId: "admin-u",
      impersonationSessionId: "imp-1",
    } as ReturnType<typeof getImpersonationContext>);
    const { tx, inserted } = makeTx();
    await commitAccessChange(tx, ORG, { audit: { action: "a.b", userId: "u-1" } });
    await commitAccessChange(tx, ORG, { audit: { action: "a.c", userId: "u-1" } });
    expect(inserted[0]?.row).toMatchObject({
      metadata: expect.objectContaining({ impersonatedBy: "admin-u", impersonationSessionId: "imp-1" }),
    });
    expect((inserted[1]?.row as { metadata: object }).metadata).not.toHaveProperty("impersonatedBy");
  });

  it("stamps the request IP from the observability context for forensics", async () => {
    jest.mocked(getObservabilityContext).mockReturnValueOnce({ ipAddress: "1.2.3.4" } as ReturnType<
      typeof getObservabilityContext
    >);
    const { tx, inserted } = makeTx();
    await commitAccessChange(tx, ORG, { audit: { action: "a.b", userId: "u-1" } });
    expect(inserted[0]?.row).toMatchObject({ ipAddress: "1.2.3.4" });
  });
});

describe("commitAccessChange — grant intent (permissions loss)", () => {
  it("defers the session bust until after commit when a request transaction is open", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        audit: { action: "access.grant_removed", userId: "actor" },
        revoke: { cache: asCache(cache), loses: [{ kind: "permissions", userIds: ["target"] }] },
      }),
    );
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    await drain(hooks);

    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("target"));
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });

  it("runs the session bust inline when registerAfterCommit has no context, never dropping it", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "permissions", userIds: ["target"] }] },
    });
    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("target"));
  });

  it("schedules nothing when the intent names nobody", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        revoke: { cache: asCache(cache), loses: [{ kind: "permissions", userIds: [] }] },
      }),
    );
    expect(hooks).toHaveLength(0);
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
  });
});

describe("commitAccessChange — role intent (role-holders loss)", () => {
  it("resolves every direct and group holder inside the tx, paging past one page, and busts them with the list key after commit", async () => {
    const firstPage = memberRows(1, REVOCATION_PAGE_SIZE);
    const secondPage = memberRows(1 + REVOCATION_PAGE_SIZE, 2);
    const { tx, selects } = makeTx([
      firstPage,
      secondPage,
      [{ groupId: "group-1" }],
      [{ membershipId: 900, userId: "group-member" }],
    ]);
    const cache = makeCache();
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        audit: { action: "role.permissions.set", userId: "actor" },
        revoke: {
          cache: asCache(cache),
          loses: [{ kind: "role-holders", roleId: 7 }],
          listKeys: [CACHE_KEYS.rolesList(ORG)],
        },
      }),
    );

    expect(selects).toHaveBeenCalledTimes(4);
    expect(cache.invalidateMany).not.toHaveBeenCalled();

    await drain(hooks);

    const keys = jest.mocked(cache.invalidateMany).mock.calls[0]?.[0] as string[];
    expect(keys).toContain(CACHE_KEYS.rolesList(ORG));
    expect(keys).toContain(CACHE_KEYS.userSession(`user-${String(REVOCATION_PAGE_SIZE + 2)}`));
    expect(keys).toContain(CACHE_KEYS.userSession("group-member"));
    expect(keys).toHaveLength(REVOCATION_PAGE_SIZE + 4);
  });

  it("does not look up group members when no group holds the role", async () => {
    const { tx, selects } = makeTx([[{ membershipId: 1, userId: "solo" }], []]);
    const cache = makeCache();
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "role-holders", roleId: 7 }] },
    });
    expect(selects).toHaveBeenCalledTimes(2);
    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("solo"));
  });
});

describe("commitAccessChange — membership and group intents", () => {
  it("resolves membership ids to users inside the tx", async () => {
    const { tx } = makeTx([[{ userId: "u-a" }, { userId: "u-b" }]]);
    const cache = makeCache();
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "memberships", membershipIds: [1, 2] }] },
    });
    expect(cache.invalidateMany).toHaveBeenCalledWith([
      CACHE_KEYS.userSession("u-a"),
      CACHE_KEYS.userSession("u-b"),
    ]);
  });

  it("resolves a group's members inside the tx", async () => {
    const { tx } = makeTx([[{ membershipId: 3, userId: "g-1" }]]);
    const cache = makeCache();
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "group-members", groupId: "group-x" }] },
    });
    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("g-1"));
  });

  it("issues no read for an empty membership list", async () => {
    const { tx, selects } = makeTx();
    const cache = makeCache();
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "memberships", membershipIds: [] }] },
    });
    expect(selects).not.toHaveBeenCalled();
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
  });
});

describe("commitAccessChange — ownership intent (standing loss)", () => {
  it("busts both parties' sessions and membership status after commit, and notifies inside the commit", async () => {
    const { tx, inserted } = makeTx();
    const cache = makeCache();
    const notifier = { emit: jest.fn().mockResolvedValue(undefined) };
    const event = { eventKey: "ownership.transfer.accepted", targetUserIds: ["from"] };
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        audit: { action: "ownership.transfer_accepted", userId: "to" },
        revoke: { cache: asCache(cache), loses: [{ kind: "standing", userIds: ["to", "from"] }] },
        notify: { via: notifier, events: [event] },
      }),
    );

    expect(inserted[0]?.row).toMatchObject({ action: "ownership.transfer_accepted" });
    expect(notifier.emit).toHaveBeenCalledWith(event);
    expect(bustMembershipStatusCacheMany).not.toHaveBeenCalled();

    await drain(hooks);

    expect(cache.invalidateMany).toHaveBeenCalledWith([
      CACHE_KEYS.userSession("to"),
      CACHE_KEYS.userSession("from"),
    ]);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(cache, ["to", "from"]);
  });

  it("emits nothing when the notification carries no events", async () => {
    const { tx } = makeTx();
    const notifier = { emit: jest.fn().mockResolvedValue(undefined) };
    await commitAccessChange(tx, ORG, { notify: { via: notifier, events: [] } });
    expect(notifier.emit).not.toHaveBeenCalled();
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
  });
});

describe("commitAccessChange — identity intent (session revocation)", () => {
  it("marks sessions revoked on the tx and publishes tombstones and the membership bust only after commit", async () => {
    const { tx, updates } = makeTx([], [{ id: "s-1" }, { id: "s-2" }]);
    const cache = makeCache();
    const sessions = { publishRevocations: jest.fn().mockResolvedValue(undefined) };
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        revoke: { cache: asCache(cache), loses: [{ kind: "identity", userId: "subject", sessions }] },
      }),
    );

    expect(updates).toHaveBeenCalledWith(userSessions);
    expect(sessions.publishRevocations).not.toHaveBeenCalled();
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();

    await drain(hooks);

    expect(sessions.publishRevocations).toHaveBeenCalledWith(["s-1", "s-2"]);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, "subject");
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it("does not fail the commit when Redis is down; the tombstone failure surfaces from the after-commit hook", async () => {
    const { tx } = makeTx([], [{ id: "s-1" }]);
    const cache = makeCache();
    const sessions = { publishRevocations: jest.fn().mockRejectedValue(new Error("redis down")) };
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        revoke: { cache: asCache(cache), loses: [{ kind: "identity", userId: "subject", sessions }] },
      }),
    );

    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
    const results = await Promise.allSettled(hooks.map((hook) => hook()));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, "subject");
  });

  it("publishes inline when there is no after-commit context, never dropping the tombstone", async () => {
    const { tx } = makeTx([], [{ id: "s-1" }]);
    const cache = makeCache();
    const sessions = { publishRevocations: jest.fn().mockResolvedValue(undefined) };
    await commitAccessChange(tx, ORG, {
      revoke: { cache: asCache(cache), loses: [{ kind: "identity", userId: "subject", sessions }] },
    });
    expect(sessions.publishRevocations).toHaveBeenCalledWith(["s-1"]);
  });

  it("publishes nothing when the subject had no live session", async () => {
    const { tx, updates } = makeTx([], []);
    const cache = makeCache();
    const sessions = { publishRevocations: jest.fn().mockResolvedValue(undefined) };
    const { hooks } = await inRequest(() =>
      commitAccessChange(tx, ORG, {
        revoke: { cache: asCache(cache), loses: [{ kind: "identity", userId: "subject", sessions }] },
      }),
    );
    await drain(hooks);
    expect(updates).toHaveBeenCalledWith(userSessions);
    expect(sessions.publishRevocations).not.toHaveBeenCalled();
  });
});

describe("standing revocation outside a commit", () => {
  it("busts membership status and, when asked, the session keys after commit for an org teardown", async () => {
    const cache = makeCache();
    const { hooks } = await inRequest(() =>
      scheduleStandingRevocation(asCache(cache), ["u-1", "u-2"], { withSessions: true }),
    );
    expect(cache.invalidateMany).not.toHaveBeenCalled();
    await drain(hooks);
    expect(cache.invalidateMany).toHaveBeenCalledWith([
      CACHE_KEYS.userSession("u-1"),
      CACHE_KEYS.userSession("u-2"),
    ]);
    expect(bustMembershipStatusCacheMany).toHaveBeenCalledWith(cache, ["u-1", "u-2"]);
  });

  it("leaves session keys alone by default so a membership drain busts only status", async () => {
    const cache = makeCache();
    await scheduleStandingRevocation(asCache(cache), ["u-1"]);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, "u-1");
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it("defers a membership revocation's status and session bust to after commit, never busting before it", async () => {
    const cache = makeCache();
    const { hooks } = await inRequest(() => scheduleStandingRevocation(asCache(cache), ["u-1"], { withSessions: true }));
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);
    await drain(hooks);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
    expect(bustMembershipStatusCache).toHaveBeenCalledWith(cache, "u-1");
  });
});

describe("commitAccessChange — caller afterCommit (BE-85)", () => {
  it("registers the caller's work after the revocation and does not run it before commit", async () => {
    const { tx } = makeTx();
    const work = jest.fn().mockResolvedValue(undefined);
    const { hooks } = await inRequest(() => commitAccessChange(tx, ORG, { afterCommit: work }));
    expect(work).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);
    await drain(hooks);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("runs the caller's work inline when there is no after-commit context", async () => {
    const { tx } = makeTx();
    const work = jest.fn().mockResolvedValue(undefined);
    await commitAccessChange(tx, ORG, { afterCommit: work });
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe("commitAccessChange — transaction failure", () => {
  const completions: Promise<unknown>[] = [];
  let stopObserving: () => void = () => undefined;

  beforeEach(() => {
    completions.length = 0;
    stopObserving = observeAfterCommitWork((completion) => {
      completions.push(completion.catch(() => undefined));
    });
    jest.mocked(withTenant).mockImplementation((_db, _ctx, fn) => fn({} as never));
  });

  afterEach(() => stopObserving());

  function commitThen(
    tx: DbOrTx,
    cache: ReturnType<typeof makeCache>,
    work: jest.Mock,
    fail: boolean,
  ): Promise<void> {
    return runInTenantTransaction(
      {} as Db,
      async () => {
        await commitAccessChange(tx, ORG, {
          revoke: { cache: asCache(cache), loses: [{ kind: "permissions", userIds: ["target"] }] },
          afterCommit: work,
        });
        if (fail) throw new Error("rolled back");
      },
      { orgId: ORG },
    );
  }

  it("runs no revocation and no caller work when the transaction throws after the commit call", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const work = jest.fn().mockResolvedValue(undefined);

    await expect(commitThen(tx, cache, work, true)).rejects.toThrow("rolled back");
    await Promise.all(completions);

    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
    expect(completions).toHaveLength(0);
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it("runs the revocation and the caller work once the same transaction commits", async () => {
    const { tx } = makeTx();
    const cache = makeCache();
    const work = jest.fn().mockResolvedValue(undefined);

    await commitThen(tx, cache, work, false);
    await Promise.all(completions);

    expect(completions).toHaveLength(2);
    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("target"));
    expect(work).toHaveBeenCalledTimes(1);
  });
});
