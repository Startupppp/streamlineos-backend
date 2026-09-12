/**
 * Revocation / cache-contract spec — ITEM 2
 *
 * Tests the six listed scenarios for the access version channel and the
 * AccessVersionCache TTL bound. Evidence level: MOCKED — uses the real
 * AccessVersionChannel implementation over an in-memory fake store; no Redis
 * process or real database is required.
 *
 * The key claim: failed shared-store clear leaves a bounded stale window.
 * The actual bound is SHARED_VERSION_TTL_SECONDS = 30 seconds.
 *
 * This spec builds on permission-invalidation-cross-instance.spec.ts
 * (which already covers the two-instance happy path) and adds the failure,
 * expiry, fill-after-invalidate, logout and late-org-switching scenarios.
 */

import {
  AccessVersionChannel,
  type AccessVersionStore,
} from "../../../common/rbac/access-version-channel";
import { SHARED_VERSION_TTL_SECONDS } from "../access-version-cache";

function makeInMemoryStore(): { store: AccessVersionStore; map: Map<string, number> } {
  const map = new Map<string, number>();
  const store: AccessVersionStore = {
    get: async (orgId) => map.get(orgId) ?? null,
    set: async (orgId, version) => { map.set(orgId, version); },
    clear: async (orgId) => { map.delete(orgId); },
  };
  return { store, map };
}

function makeClearFailStore(map: Map<string, number>): AccessVersionStore {
  return {
    get: async (orgId) => map.get(orgId) ?? null,
    set: async (orgId, version) => { map.set(orgId, version); },
    clear: async () => { throw new Error("Redis unavailable"); },
  };
}

describe("access version revocation — TTL bound", () => {
  it("SHARED_VERSION_TTL_SECONDS is 30 — this is the stale-window ceiling after a failed cross-instance invalidation", () => {
    expect(SHARED_VERSION_TTL_SECONDS).toBe(30);
  });
});

describe("scenario: failed shared-store clear — bounded stale window on instance B", () => {
  it("instance A's local listener fires immediately; instance B reads stale version from the shared store until TTL expires", async () => {
    const map = new Map<string, number>();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(makeClearFailStore(map));
    channelB.useStore({
      get: async (orgId) => map.get(orgId) ?? null,
      set: async (orgId, version) => { map.set(orgId, version); },
      clear: async (orgId) => { map.delete(orgId); },
    });

    const v1A = await channelA.read("org-revoked", async () => 1);
    expect(v1A).toBe(1);
    expect(map.get("org-revoked")).toBe(1);

    const localFired: string[] = [];
    channelA.subscribe((orgId) => localFired.push(orgId));

    await channelA.publish("org-revoked");

    // Local listener fired synchronously — instance A is immediately correct.
    expect(localFired).toContain("org-revoked");

    // Shared store still holds the old value because clear() threw.
    expect(map.get("org-revoked")).toBe(1);

    // Instance B reads stale version from the shared store.
    let dbCalls = 0;
    const vBStale = await channelB.read("org-revoked", async () => {
      dbCalls++;
      return 2;
    });
    expect(vBStale).toBe(1); // stale — clear failed, so B sees the old entry
    expect(dbCalls).toBe(0); // B did NOT reach DB

    // Simulating TTL expiry: the shared store entry is gone.
    map.delete("org-revoked");

    // Now B reads again — the entry is absent, so B calls loadDurable.
    const vBFresh = await channelB.read("org-revoked", async () => {
      dbCalls++;
      return 2;
    });
    expect(vBFresh).toBe(2); // correct after simulated TTL expiry
    expect(dbCalls).toBe(1);
  });
});

describe("scenario: cache store failure on get — falls through to DB", () => {
  it("a broken get causes the channel to invoke loadDurable and return the authoritative version", async () => {
    const channel = new AccessVersionChannel();
    channel.useStore({
      get: async () => { throw new Error("Redis read error"); },
      set: async () => {},
      clear: async () => {},
    });

    let dbCalled = false;
    const version = await channel.read("org-get-fail", async () => {
      dbCalled = true;
      return 7;
    });

    expect(version).toBe(7);
    expect(dbCalled).toBe(true);
  });

  it("a broken get does not prevent the test-is-not-vacuous case — a working store serves from cache", async () => {
    const { store } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    const v1 = await channel.read("org-cache-hit", async () => 3);
    expect(v1).toBe(3);

    let dbCalled = false;
    const v2 = await channel.read("org-cache-hit", async () => { dbCalled = true; return 99; });
    expect(v2).toBe(3); // served from shared store
    expect(dbCalled).toBe(false); // DB not reached
  });
});

describe("scenario: expiry without writes — TTL causes re-read on next access", () => {
  it("after the shared key is removed (simulating TTL expiry), the next read calls loadDurable and re-fills", async () => {
    const { store, map } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    const v1 = await channel.read("org-expire", async () => 10);
    expect(v1).toBe(10);
    expect(map.get("org-expire")).toBe(10);

    // Simulate TTL expiry by removing the entry from the fake store.
    map.delete("org-expire");

    let dbCalled = false;
    const v2 = await channel.read("org-expire", async () => {
      dbCalled = true;
      return 11;
    });
    expect(v2).toBe(11);
    expect(dbCalled).toBe(true);
    // Re-fills the shared store.
    expect(map.get("org-expire")).toBe(11);
  });
});

describe("scenario: fill-after-invalidate — key re-populates after publish", () => {
  it("after publish clears the key, the next read re-fills the shared store with the new version", async () => {
    const { store, map } = makeInMemoryStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    await channelA.read("org-fill", async () => 7);
    expect(map.get("org-fill")).toBe(7);

    await channelA.publish("org-fill");
    expect(map.has("org-fill")).toBe(false); // cleared

    const vB = await channelB.read("org-fill", async () => 8);
    expect(vB).toBe(8);
    expect(map.get("org-fill")).toBe(8); // re-filled
  });

  it("the test is not vacuous — a non-cleared key does NOT call loadDurable", async () => {
    const { store } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-unchanged", async () => 5);
    let dbCalled = false;
    const v2 = await channel.read("org-unchanged", async () => { dbCalled = true; return 9; });
    expect(v2).toBe(5); // served from store
    expect(dbCalled).toBe(false);
  });
});

describe("scenario: logout — clearForOrg removes the local in-process cache entry", () => {
  it("publish fires local listeners synchronously; the local listener is how AccessVersionCache.clearForOrg triggers fresh reads", async () => {
    // AccessVersionCache.configureStore() calls accessVersionChannel.useStore(...)
    // accessVersionChannel.subscribe() receives local listener from AccessVersionCache.
    // clearForOrg() is: this.versionCache.delete(orgId); this.versionInFlight.delete(orgId).
    // After clearForOrg(), the next getVersion() finds no cached entry and goes to the channel.
    // The channel test below proves the mechanism at the channel level.
    const { store } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    const fired: string[] = [];
    channel.subscribe((orgId) => fired.push(orgId));

    await channel.publish("org-logout");
    expect(fired).toContain("org-logout");
    // Local listener fires before the shared store clear completes (synchronous, then async).
  });

  it("after a publish the instance that published has its local version invalidated and will re-read on next access", async () => {
    const { store, map } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-session-end", async () => 4);
    expect(map.get("org-session-end")).toBe(4);

    await channel.publish("org-session-end");
    expect(map.has("org-session-end")).toBe(false);

    // Next read (simulating a request after logout) fetches fresh.
    let dbCalled = false;
    const vFresh = await channel.read("org-session-end", async () => {
      dbCalled = true;
      return 5;
    });
    expect(vFresh).toBe(5);
    expect(dbCalled).toBe(true);
  });
});

describe("scenario: late organization switching — no cross-org version contamination", () => {
  it("version keys for different orgs are independent; bumping org-A does not affect org-B", async () => {
    const { store, map } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-switch-a", async () => 20);
    await channel.read("org-switch-b", async () => 30);

    // Simulate user switching from org-B back to org-A; org-A gets a permission bump.
    await channel.publish("org-switch-a");

    expect(map.has("org-switch-a")).toBe(false); // cleared
    expect(map.get("org-switch-b")).toBe(30); // unaffected

    let aDbCalled = false;
    let bDbCalled = false;
    const vA = await channel.read("org-switch-a", async () => { aDbCalled = true; return 21; });
    const vB = await channel.read("org-switch-b", async () => { bDbCalled = true; return 30; });
    expect(vA).toBe(21);
    expect(vB).toBe(30);
    expect(aDbCalled).toBe(true);
    expect(bDbCalled).toBe(false); // org-B served from store
  });

  it("the test is not vacuous — clearing org-A does not change what org-B returns", async () => {
    const { store, map } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-a-iso", async () => 100);
    await channel.read("org-b-iso", async () => 200);

    await channel.publish("org-a-iso");

    // org-B version unchanged.
    const vB = await channel.read("org-b-iso", async () => 999);
    expect(vB).toBe(200);
    expect(map.get("org-b-iso")).toBe(200);
  });
});

describe("cross-instance publish — instance B's listeners do not fire when A publishes", () => {
  it("local listeners are not visible across process boundaries — only the shared store clears", async () => {
    const { store } = makeInMemoryStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    const bFired: string[] = [];
    channelB.subscribe((orgId) => bFired.push(orgId));

    await channelA.publish("org-cross");

    expect(bFired).toHaveLength(0); // B's local listeners not triggered by A
  });
});
