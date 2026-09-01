import { readPayrollKeysetBatches } from "./payroll-keyset-batch";

describe("readPayrollKeysetBatches", () => {
  it("resumes after the last id and returns every row", async () => {
    const calls: Array<number | null> = [];
    const result = await readPayrollKeysetBatches({
      batchSize: 2,
      fetch: async (afterId, limit) => {
        calls.push(afterId);
        const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        return rows.filter((row) => afterId === null || row.id > afterId).slice(0, limit);
      },
      idOf: (row) => row.id,
    });

    expect(result.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual([null, 2, 4]);
  });

  it("rejects a non-advancing cursor instead of looping forever", async () => {
    await expect(
      readPayrollKeysetBatches({
        batchSize: 1,
        fetch: async () => [{ id: 1 }],
        idOf: (row) => row.id,
      }),
    ).rejects.toThrow("did not advance");
  });
});
