import { boundedMap } from "./bounded-map";

describe("boundedMap", () => {
  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, index) => index);

    await boundedMap(items, 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(8);
  });

  it("runs every item", async () => {
    const seen: number[] = [];
    await boundedMap([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps going when one item fails, and reports which failed", async () => {
    const results = await boundedMap([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    });

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });

  it("does nothing for an empty list", async () => {
    const run = jest.fn();
    await boundedMap([], 4, run);
    expect(run).not.toHaveBeenCalled();
  });
});
