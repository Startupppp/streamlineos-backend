import {
  AccessVersionChannel,
  type AccessVersionStore,
} from "../../../common/rbac/access-version-channel";

function makeInMemoryStore(): {
  store: AccessVersionStore;
  map: Map<string, number>;
} {
  const map = new Map<string, number>();
  const store: AccessVersionStore = {
    get: async (orgId) => map.get(orgId) ?? null,
    set: async (orgId, version) => {
      map.set(orgId, version);
    },
    clear: async (orgId) => {
      map.delete(orgId);
    },
  };
  return { store, map };
}

describe("cross-instance permission version invalidation — §28.4 A", () => {
  it("publish clears the shared version key so instance B re-reads the version from DB", async () => {
    const { store, map } = makeInMemoryStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    let dbReadCount = 0;
    const loadFromDb = async (): Promise<number> => {
      dbReadCount++;
      return 2;
    };

    const v1 = await channelA.read("org-test", async () => 1);
    expect(v1).toBe(1);
    expect(map.get("org-test")).toBe(1);

    const vB1 = await channelB.read("org-test", loadFromDb);
    expect(vB1).toBe(1);
    expect(dbReadCount).toBe(0);

    await channelA.publish("org-test");
    expect(map.has("org-test")).toBe(false);

    const vB2 = await channelB.read("org-test", loadFromDb);
    expect(vB2).toBe(2);
    expect(dbReadCount).toBe(1);
  });

  it("local listeners on the publishing instance fire synchronously before the Redis clear", async () => {
    const { store } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    const fired: string[] = [];
    channel.subscribe((orgId) => fired.push(`listener:${orgId}`));

    await channel.publish("org-x");

    expect(fired).toEqual(["listener:org-x"]);
  });

  it("version key re-populates in the shared store after the next read", async () => {
    const { store, map } = makeInMemoryStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    await channelA.read("org-repop", async () => 1);
    await channelA.publish("org-repop");
    expect(map.has("org-repop")).toBe(false);

    await channelB.read("org-repop", async () => 3);
    expect(map.get("org-repop")).toBe(3);
  });

  it("publishing for one org does not clear another org's version key", async () => {
    const { store, map } = makeInMemoryStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-a", async () => 10);
    await channel.read("org-b", async () => 20);

    await channel.publish("org-a");

    expect(map.has("org-a")).toBe(false);
    expect(map.get("org-b")).toBe(20);
  });

  it("instance B with no local listeners fires no callbacks on publish from A", async () => {
    const { store } = makeInMemoryStore();
    const channelA = new AccessVersionChannel();
    const channelB = new AccessVersionChannel();
    channelA.useStore(store);
    channelB.useStore(store);

    const bFired: string[] = [];
    channelB.subscribe((orgId) => bFired.push(orgId));

    await channelA.publish("org-z");

    expect(bFired).toEqual([]);
  });
});
