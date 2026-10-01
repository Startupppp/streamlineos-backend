import { AccessVersionChannel } from "./access-version-channel";

describe("AccessVersionChannel", () => {
  it("notifies every local listener synchronously on publish", () => {
    const channel = new AccessVersionChannel();
    const seen: string[] = [];
    channel.subscribe((orgId) => seen.push(`a:${orgId}`));
    channel.subscribe((orgId) => seen.push(`b:${orgId}`));

    channel.publish("org-1");

    expect(seen).toEqual(["a:org-1", "b:org-1"]);
  });

  it("does not cross instances; another instance learns of a bump only from the durable row", () => {
    const instanceA = new AccessVersionChannel();
    const instanceB = new AccessVersionChannel();
    const seenOnA: string[] = [];
    const seenOnB: string[] = [];
    instanceA.subscribe((orgId) => seenOnA.push(orgId));
    instanceB.subscribe((orgId) => seenOnB.push(orgId));

    instanceA.publish("org-1");

    expect(seenOnA).toEqual(["org-1"]);
    expect(seenOnB).toEqual([]);
  });

  it("stops notifying a listener once it unsubscribes", () => {
    const channel = new AccessVersionChannel();
    const seen: string[] = [];
    const unsubscribe = channel.subscribe((orgId) => seen.push(orgId));

    channel.publish("org-1");
    unsubscribe();
    channel.publish("org-2");

    expect(seen).toEqual(["org-1"]);
  });

  it("drops every listener on reset", () => {
    const channel = new AccessVersionChannel();
    const seen: string[] = [];
    channel.subscribe((orgId) => seen.push(orgId));

    channel.reset();
    channel.publish("org-1");

    expect(seen).toEqual([]);
  });
});
