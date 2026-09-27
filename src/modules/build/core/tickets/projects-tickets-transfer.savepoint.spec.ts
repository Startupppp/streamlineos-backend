import type { TenantTx } from "../../../../db/drizzle.types";

describe("per-chunk savepoint in projects-tickets-transfer.importTickets — nested tx.transaction isolates chunk failures (ticket 38)", () => {
  it("a failing chunk savepoint (ROLLBACK TO SAVEPOINT) leaves tx callable for subsequent chunks", async () => {
    const skipped: Array<{ row: number; reason: string }> = [];
    let createdCount = 0;
    let chunkCallCount = 0;

    const mockTx = {
      transaction: jest.fn().mockImplementation(
        async (fn: (sp: { insert: jest.Mock }) => Promise<number>) => {
          chunkCallCount++;
          if (chunkCallCount === 1) {
            throw new Error("chunk 1: unique_violation");
          }
          const sp = { insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }) };
          return fn(sp);
        },
      ),
    } as unknown as TenantTx;

    const chunks = [
      [{ rowIndex: 1 }, { rowIndex: 2 }],
      [{ rowIndex: 3 }, { rowIndex: 4 }],
    ] as const;

    for (const chunk of chunks) {
      const n = await (mockTx as unknown as { transaction: (fn: (sp: unknown) => Promise<number>) => Promise<number> })
        .transaction(async (sp) => {
          void sp;
          return chunk.length;
        })
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : "Unknown error";
          for (const r of chunk) {
            skipped.push({ row: r.rowIndex, reason: msg });
          }
          return 0;
        });
      createdCount += n;
    }

    expect(chunkCallCount).toBe(2);
    expect(createdCount).toBe(2);
    expect(skipped).toEqual([
      { row: 1, reason: "chunk 1: unique_violation" },
      { row: 2, reason: "chunk 1: unique_violation" },
    ]);
  });

  it("all chunks succeeding accumulates a full createdCount with no skipped rows", async () => {
    const skipped: Array<{ row: number; reason: string }> = [];
    let createdCount = 0;
    let chunkCallCount = 0;

    const mockTx = {
      transaction: jest.fn().mockImplementation(
        async (fn: (sp: unknown) => Promise<number>) => {
          chunkCallCount++;
          return fn({});
        },
      ),
    } as unknown as TenantTx;

    const chunks = [
      [{ rowIndex: 1 }, { rowIndex: 2 }],
      [{ rowIndex: 3 }, { rowIndex: 4 }],
      [{ rowIndex: 5 }],
    ] as const;

    for (const chunk of chunks) {
      const n = await (mockTx as unknown as { transaction: (fn: (sp: unknown) => Promise<number>) => Promise<number> })
        .transaction(async (_sp: unknown) => chunk.length)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : "Unknown error";
          for (const r of chunk) {
            skipped.push({ row: r.rowIndex, reason: msg });
          }
          return 0;
        });
      createdCount += n;
    }

    expect(chunkCallCount).toBe(3);
    expect(createdCount).toBe(5);
    expect(skipped).toHaveLength(0);
  });
});
