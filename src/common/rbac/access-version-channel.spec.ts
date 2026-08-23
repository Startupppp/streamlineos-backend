import {
  AccessVersionChannel,
  type AccessVersionStore,
} from "./access-version-channel";

/**
 * Two channels over one store are two application instances over one cache.
 * Nothing in the local listener set crosses that boundary, which is the defect
 * this module exists to close.
 */
function sharedStore(): AccessVersionStore & { keys: () => string[] } {
  const entries = new Map<string, number>();
  return {
    get: (orgId) => Promise.resolve(entries.get(orgId) ?? null),
    set: (orgId, version) => {
      entries.set(orgId, version);
      return Promise.resolve();
    },
    clear: (orgId) => {
      entries.delete(orgId);
      return Promise.resolve();
    },
    keys: () => [...entries.keys()],
  };
}

function throwingStore(): AccessVersionStore {
  return {
    get: () => Promise.reject(new Error("cache unavailable")),
    set: () => Promise.reject(new Error("cache unavailable")),
    clear: () => Promise.reject(new Error("cache unavailable")),
  };
}

describe("AccessVersionChannel", () => {
  it("carries a bump from one instance to another through the shared store", async () => {
    const store = sharedStore();
    const instanceA = new AccessVersionChannel();
    const instanceB = new AccessVersionChannel();
    instanceA.useStore(store);
    instanceB.useStore(store);

    let durable = 7;
    const load = (): Promise<number> => Promise.resolve(durable);

    expect(await instanceA.read("org-1", load)).toBe(7);
    expect(await instanceB.read("org-1", load)).toBe(7);

    durable = 8;
    await instanceA.publish("org-1");

    expect(await instanceB.read("org-1", load)).toBe(8);
  });

  it("serves the shared value without consulting the durable row", async () => {
    const store = sharedStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);
    const load = jest.fn().mockResolvedValue(3);

    await channel.read("org-1", load);
    await channel.read("org-1", load);
    await channel.read("org-1", load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("notifies local listeners synchronously before the shared signal", async () => {
    const channel = new AccessVersionChannel();
    channel.useStore(sharedStore());
    const seen: string[] = [];
    channel.subscribe((orgId) => seen.push(orgId));

    const pending = channel.publish("org-1");
    expect(seen).toEqual(["org-1"]);
    await pending;
  });

  it("still notifies local listeners when the store throws", async () => {
    const channel = new AccessVersionChannel();
    channel.useStore(throwingStore());
    const seen: string[] = [];
    channel.subscribe((orgId) => seen.push(orgId));

    await expect(channel.publish("org-1")).resolves.toBeUndefined();

    expect(seen).toEqual(["org-1"]);
  });

  it("falls back to the durable row when the store throws, rather than to zero", async () => {
    const channel = new AccessVersionChannel();
    channel.useStore(throwingStore());

    await expect(channel.read("org-1", () => Promise.resolve(9))).resolves.toBe(9);
  });

  it("falls back to the durable row when no store is configured", async () => {
    const channel = new AccessVersionChannel();

    await expect(channel.read("org-1", () => Promise.resolve(4))).resolves.toBe(4);
  });

  it("seeds the shared value from the durable row on a cold key", async () => {
    const store = sharedStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    await channel.read("org-1", () => Promise.resolve(12));

    await expect(store.get("org-1")).resolves.toBe(12);
  });

  it("never reports a version lower than the durable row after a bump", async () => {
    const store = sharedStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);

    let durable = 41;
    const load = (): Promise<number> => Promise.resolve(durable);
    await channel.read("org-1", load);

    durable = 42;
    await channel.publish("org-1");

    await expect(channel.read("org-1", load)).resolves.toBe(42);
  });

  it("leaves another organization's version untouched", async () => {
    const store = sharedStore();
    const channel = new AccessVersionChannel();
    channel.useStore(store);
    await channel.read("org-1", () => Promise.resolve(1));
    await channel.read("org-2", () => Promise.resolve(5));

    await channel.publish("org-1");

    expect(store.keys()).toEqual(["org-2"]);
    await expect(store.get("org-2")).resolves.toBe(5);
  });

  it("stops notifying a listener once it unsubscribes", async () => {
    const channel = new AccessVersionChannel();
    const seen: string[] = [];
    const unsubscribe = channel.subscribe((orgId) => seen.push(orgId));

    await channel.publish("org-1");
    unsubscribe();
    await channel.publish("org-2");

    expect(seen).toEqual(["org-1"]);
  });
});
