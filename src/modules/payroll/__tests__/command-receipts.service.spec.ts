import { UnprocessableEntityException } from "@nestjs/common";
import { PayrollCommandReceiptsService } from "../command-receipts.service";

type UpdateReturning = Array<{ id: number }>;

function makeDb(existing: unknown, updateReturning: UpdateReturning = [{ id: 1 }]) {
  const findFirst = jest.fn().mockResolvedValue(existing);
  const updateWhere = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue(updateReturning),
  });
  const set = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set });
  const insertReturning = jest.fn().mockResolvedValue([{ id: 99 }]);
  const values = jest.fn().mockReturnValue({ returning: insertReturning });
  const insert = jest.fn().mockReturnValue({ values });
  return {
    query: { payrollCommandReceipts: { findFirst } },
    insert,
    update,
    _findFirst: findFirst,
    _updateWhere: updateWhere,
  };
}

describe("PayrollCommandReceiptsService", () => {
  it("replays a succeeded receipt", async () => {
    const db = makeDb({
      id: 1,
      status: "SUCCEEDED",
      response: { runId: 42 },
      requestHash: null,
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
      requestHash: null,
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

  it("FAILED branch: rejects a reused key with a different requestHash (422)", async () => {
    const db = makeDb({
      id: 3,
      status: "FAILED",
      requestHash: "original-hash",
      startedAt: new Date(),
      response: null,
    });
    const service = new PayrollCommandReceiptsService(db as never);

    await expect(
      service.begin({
        orgId: "org-a",
        command: "run.create",
        idempotencyKey: "k4",
        actorId: "u1",
        requestHash: "a-different-hash",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("FAILED branch: reclaims the key when requestHash matches and optimistic lock wins", async () => {
    const db = makeDb(
      {
        id: 4,
        status: "FAILED",
        requestHash: "same-hash",
        startedAt: new Date(),
        response: null,
      },
      [{ id: 4 }],
    );
    const service = new PayrollCommandReceiptsService(db as never);

    const result = await service.begin({
      orgId: "org-a",
      command: "run.create",
      idempotencyKey: "k5",
      actorId: "u1",
      requestHash: "same-hash",
    });

    expect(result.kind).toBe("fresh");
    if (result.kind === "fresh") {
      expect(result.receiptId).toBe(4);
    }
  });

  it("FAILED branch: optimistic lock lost (0 rows affected) returns inflight", async () => {
    const db = makeDb(
      {
        id: 5,
        status: "FAILED",
        requestHash: null,
        startedAt: new Date(),
        response: null,
      },
      [],
    );
    const service = new PayrollCommandReceiptsService(db as never);

    const result = await service.begin({
      orgId: "org-a",
      command: "run.create",
      idempotencyKey: "k6",
      actorId: "u1",
    });

    expect(result).toEqual({ kind: "inflight" });
  });
});
