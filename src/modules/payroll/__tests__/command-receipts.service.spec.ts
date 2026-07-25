import { PayrollCommandReceiptsService } from "../command-receipts.service";

function makeDb(existing: unknown) {
  const findFirst = jest.fn().mockResolvedValue(existing);
  const returning = jest.fn().mockResolvedValue([{ id: 99 }]);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
  const update = jest.fn().mockReturnValue({ set });
  return {
    query: { payrollCommandReceipts: { findFirst } },
    insert,
    update,
    _findFirst: findFirst,
    _returning: returning,
  };
}

describe("PayrollCommandReceiptsService", () => {
  it("replays a succeeded receipt", async () => {
    const db = makeDb({
      id: 1,
      status: "SUCCEEDED",
      response: { runId: 42 },
      startedAt: new Date(),
    });
    const service = new PayrollCommandReceiptsService(db as never);

    const result = await service.begin({
      orgId: "org-a",
      command: "run.create",
      idempotencyKey: "k1",
      actorId: "u1",
    });

    expect(result).toEqual({ kind: "replay", response: { runId: 42 } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns inflight for a recent concurrent attempt", async () => {
    const db = makeDb({
      id: 2,
      status: "IN_FLIGHT",
      startedAt: new Date(),
      response: null,
    });
    const service = new PayrollCommandReceiptsService(db as never);

    const result = await service.begin({
      orgId: "org-a",
      command: "run.generate",
      idempotencyKey: "k2",
      actorId: "u1",
      runId: 7,
    });

    expect(result).toEqual({ kind: "inflight" });
  });

  it("creates a fresh receipt when none exists", async () => {
    const db = makeDb(undefined);
    const service = new PayrollCommandReceiptsService(db as never);

    const result = await service.begin({
      orgId: "org-a",
      command: "run.recalculate",
      idempotencyKey: "k3",
      actorId: "u1",
      runId: 9,
    });

    expect(result.kind).toBe("fresh");
    if (result.kind === "fresh") {
      expect(result.receiptId).toBe(99);
      expect(result.correlationId).toBeTruthy();
    }
    expect(db.insert).toHaveBeenCalled();
  });
});
