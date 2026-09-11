import { readHrKeysetBatches } from "./hr-keyset-batch";

describe("readHrKeysetBatches", () => {
  it("continues through overflow without dropping the sentinel batch", async () => {
    const calls: Array<number | undefined> = [];
    const rows = await readHrKeysetBatches(
      async (afterId, batchSize) => {
        calls.push(afterId);
        const start = afterId ?? 0;
        return Array.from({ length: start < 8 ? batchSize : 2 }, (_, i) => ({ id: start + i + 1 }));
      },
      (row) => row.id,
      4,
    );

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(calls).toEqual([undefined, 4, 8]);
  });

  it("rejects a non-advancing reader instead of looping or losing rows", async () => {
    await expect(
      readHrKeysetBatches(async () => [{ id: 1 }, { id: 1 }], (row) => row.id, 2),
    ).rejects.toThrow("did not advance");
  });
});
