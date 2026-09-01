import {
  AccessVersionChannel,
  type AccessVersionStore,
} from "../../../common/rbac/access-version-channel";

function makeRealStore(): { store: AccessVersionStore; map: Map<string, number> } {
  const map = new Map<string, number>();
  const store: AccessVersionStore = {
    get: async (orgId) => map.get(orgId) ?? null,
    set: async (orgId, version) => { map.set(orgId, version); },
    clear: async (orgId) => { map.delete(orgId); },
  };
  return { store, map };
}

function makeNeuteredStore(): { store: AccessVersionStore; map: Map<string, number> } {
  const map = new Map<string, number>();
  const store: AccessVersionStore = {
    get: async (orgId) => map.get(orgId) ?? null,
    set: async (orgId, version) => { map.set(orgId, version); },
    clear: async (_orgId) => { return; },
  };
  return { store, map };
}

describe("POSITIVE — store.clear() forces instance B to re-read from DB after publish", () => {
  it("after publish with a real store, the shared key is absent and B calls the DB loader exactly once", async () => {
    const { store, map } = makeRealStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    await channelA.read("org-p", async () => 1);
    expect(map.get("org-p")).toBe(1);

    let dbCalls = 0;
    const fromDb = async () => {
      dbCalls++;
      return 2;
    };

    const vB1 = await channelB.read("org-p", fromDb);
    expect(vB1).toBe(1);
    expect(dbCalls).toBe(0);

    await channelA.publish("org-p");
    expect(map.has("org-p")).toBe(false);

    const vB2 = await channelB.read("org-p", fromDb);
    expect(vB2).toBe(2);
    expect(dbCalls).toBe(1);
  });

  it("publish on org-a does not evict org-b from the shared store (tenant isolation)", async () => {
    const { store, map } = makeRealStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-a", async () => 10);
    await channel.read("org-b", async () => 20);

    await channel.publish("org-a");

    expect(map.has("org-a")).toBe(false);
    expect(map.get("org-b")).toBe(20);
  });
});

describe("NEGATIVE CONTROL — neutered store.clear (no-op) proves clear() is the load-bearing seam", () => {
  it("without store.clear, publish fires listeners but B still serves the stale cached version", async () => {
    const { store, map } = makeNeuteredStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    await channelA.read("org-nc", async () => 1);
    expect(map.get("org-nc")).toBe(1);

    let dbCalls = 0;
    const fromDb = async () => {
      dbCalls++;
      return 2;
    };

    await channelB.read("org-nc", fromDb);
    expect(dbCalls).toBe(0);

    await channelA.publish("org-nc");
    expect(map.has("org-nc")).toBe(true);

    const vB2 = await channelB.read("org-nc", fromDb);
    expect(vB2).toBe(1);
    expect(dbCalls).toBe(0);
  });

  it("positive counterpart: replacing the neutered store with a real store on the same channel makes the revocation visible", async () => {
    const { store: neuteredStore } = makeNeuteredStore();
    const { store: realStore, map: realMap } = makeRealStore();

    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();

    channelA.useStore(neuteredStore);
    channelB.useStore(neuteredStore);
    await channelA.read("org-swap", async () => 1);

    channelA.useStore(realStore);
    channelB.useStore(realStore);
    await realStore.set("org-swap", 1);

    let dbCalls = 0;
    const fromDb = async () => {
      dbCalls++;
      return 2;
    };

    await channelA.publish("org-swap");
    expect(realMap.has("org-swap")).toBe(false);

    const vB = await channelB.read("org-swap", fromDb);
    expect(vB).toBe(2);
    expect(dbCalls).toBe(1);
  });
});

describe("bumpPermissionsVersion seam — publish is the cross-instance invalidation mechanism", () => {
  it("publish fires local listeners before the shared-store clear (ordering guarantee)", async () => {
    const { store } = makeRealStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    const sequence: string[] = [];
    channel.subscribe((_orgId) => sequence.push("listener"));

    const originalClear = store.clear.bind(store);
    store.clear = async (orgId) => {
      sequence.push("clear");
      return originalClear(orgId);
    };

    await channel.publish("org-seq");
    expect(sequence).toEqual(["listener", "clear"]);
  });

  it("a second instance with no subscribers does not fire callbacks when A publishes", async () => {
    const { store } = makeRealStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    const bCallbacks: string[] = [];
    channelB.subscribe((orgId) => bCallbacks.push(orgId));

    await channelA.publish("org-isolation");

    expect(bCallbacks).toHaveLength(0);
  });
});
