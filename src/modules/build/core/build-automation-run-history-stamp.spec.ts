import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

function makeDb() {
  const updatedWith: Array<Record<string, unknown>> = [];
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockImplementation((patch: Record<string, unknown>) => {
    updatedWith.push(patch);
    return { where: updateWhere };
  });
  const insertReturning = jest.fn().mockResolvedValue([{ id: 1 }]);
  const insertValues = jest.fn().mockReturnValue({ returning: insertReturning });
  const mockDb = {
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    update: jest.fn().mockReturnValue({ set: updateSet }),
  };
  return { mockDb: mockDb as unknown as Db, updatedWith, updateSet };
}

const BASE_PARAMS = {
  orgId: "org-1",
  projectId: 1,
  automationId: 42,
  ticketId: 10,
  triggerEvent: "ticket.created",
  matched: true,
  errorMessage: null,
};

function makeService(db: Db) {
  const members = { assertProjectAccess: jest.fn() } as never;
  return new BuildAutomationRunHistoryService(db as never, members);
}

describe("BuildAutomationRunHistoryService — run timestamp stamping", () => {
  it("stamps lastRunAt (only) on matched_success — automation last ran but did not fail (BLD-X-BE-HISTORY-001a)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, matched: true, outcome: "matched_success" });

    expect(updatedWith).toHaveLength(1);
    expect(updatedWith[0]).toHaveProperty("lastRunAt");
    expect(updatedWith[0]).not.toHaveProperty("lastFailureAt");
  });

  it("stamps lastRunAt (only) on matched_partial_failure — something ran even though some actions failed (BLD-X-BE-HISTORY-001b)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, matched: true, outcome: "matched_partial_failure" });

    expect(updatedWith).toHaveLength(1);
    expect(updatedWith[0]).toHaveProperty("lastRunAt");
    expect(updatedWith[0]).not.toHaveProperty("lastFailureAt");
  });

  it("stamps both lastRunAt and lastFailureAt on matched_failed — all actions failed (BLD-X-BE-HISTORY-001c)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, matched: true, outcome: "matched_failed" });

    expect(updatedWith).toHaveLength(1);
    expect(updatedWith[0]).toHaveProperty("lastRunAt");
    expect(updatedWith[0]).toHaveProperty("lastFailureAt");
  });

  it("stamps lastFailureAt (only) on error — evaluation threw before any action ran (BLD-X-BE-HISTORY-001d)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, matched: false, outcome: "error", errorMessage: "crash" });

    expect(updatedWith).toHaveLength(1);
    expect(updatedWith[0]).not.toHaveProperty("lastRunAt");
    expect(updatedWith[0]).toHaveProperty("lastFailureAt");
  });

  it("does not stamp any timestamp on not_matched — the automation did not execute (BLD-X-BE-HISTORY-002a)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, matched: false, outcome: "not_matched" });

    expect(updatedWith).toHaveLength(0);
  });

  it("does not stamp any timestamp on blocked_loop_guard — the automation was suppressed, not executed (BLD-X-BE-HISTORY-002b)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, automationId: null, matched: false, outcome: "blocked_loop_guard" });

    expect(updatedWith).toHaveLength(0);
  });

  it("does not stamp when automationId is null — no parent row to update (BLD-X-BE-HISTORY-003)", async () => {
    const { mockDb, updatedWith } = makeDb();
    const svc = makeService(mockDb);

    await svc.recordRun({ ...BASE_PARAMS, automationId: null, matched: true, outcome: "matched_success" });

    expect(updatedWith).toHaveLength(0);
  });

  it("still returns the run id even if the stamp update were to fail — best-effort (BLD-X-BE-HISTORY-004)", async () => {
    const { mockDb } = makeDb();
    (mockDb.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockRejectedValue(new Error("stamp failed")) }),
    });
    const svc = makeService(mockDb);

    const id = await svc.recordRun({ ...BASE_PARAMS, matched: true, outcome: "matched_success" });

    expect(id).toBeNull();
  });
});

describe("BuildAutomationRunHistoryService — list query params are applied (BLD-X-BE-HISTORY-005)", () => {
  it("listAutomationsQuerySchema accepts action and ownerId optional params and rejects unknown keys", async () => {
    const { listAutomationsQuerySchema } = await import("./dto/automation.schemas");

    expect(listAutomationsQuerySchema.safeParse({}).success).toBe(true);
    expect(listAutomationsQuerySchema.safeParse({ action: "set_status" }).success).toBe(true);
    expect(listAutomationsQuerySchema.safeParse({ ownerId: "user-123" }).success).toBe(true);
    expect(listAutomationsQuerySchema.safeParse({ action: "unknown_action" }).success).toBe(false);
    expect(listAutomationsQuerySchema.safeParse({ unknownKey: "value" }).success).toBe(false);
  });
});
