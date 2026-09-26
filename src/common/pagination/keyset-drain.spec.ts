import { drainIds, forEachIdPage } from "./keyset-drain";

const PAGE = 3;

function pagesOf(ids: number[]): (cursor: number | null) => Promise<{ id: number }[]> {
  return (cursor) => {
    const after = cursor === null ? ids : ids.filter((id) => id > cursor);
    return Promise.resolve(after.slice(0, PAGE).map((id) => ({ id })));
  };
}

describe("drainIds", () => {
  it("returns every id past the page size, because a bare limit would report a partial erasure as a complete one", async () => {
    const rows = await drainIds(PAGE, pagesOf([1, 2, 3, 4, 5, 6, 7]));
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns a single short page without asking for a second one", async () => {
    const page = jest.fn(pagesOf([1, 2]));
    const rows = await drainIds(PAGE, page);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("stops instead of looping forever when a full page fails to advance the cursor", async () => {
    const stuck = jest.fn(() => Promise.resolve([{ id: 9 }, { id: 9 }, { id: 9 }]));
    const rows = await drainIds(PAGE, stuck);
    expect(stuck.mock.calls.length).toBeLessThanOrEqual(2);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("forEachIdPage", () => {
  it("settles each page before reading the next, so memory stays bounded across the drain", async () => {
    const order: string[] = [];
    const ids = [1, 2, 3, 4, 5];
    await forEachIdPage(
      PAGE,
      (cursor) => {
        order.push(`read:${cursor ?? "start"}`);
        return pagesOf(ids)(cursor);
      },
      (batch) => {
        order.push(`settle:${batch.join(",")}`);
        return Promise.resolve(batch.length);
      },
    );
    expect(order).toEqual([
      "read:start",
      "settle:1,2,3",
      "read:3",
      "settle:4,5",
    ]);
  });

  it("sums what every page settled, so the caller learns the total and not the last batch", async () => {
    const settled = await forEachIdPage(PAGE, pagesOf([1, 2, 3, 4, 5]), (batch) =>
      Promise.resolve(batch.length),
    );
    expect(settled).toBe(5);
  });

  it("settles nothing and reports zero when the first page is empty", async () => {
    const settle = jest.fn(() => Promise.resolve(1));
    const settled = await forEachIdPage(PAGE, () => Promise.resolve([]), settle);
    expect(settled).toBe(0);
    expect(settle).not.toHaveBeenCalled();
  });
});
