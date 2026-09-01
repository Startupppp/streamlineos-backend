process.env.APP_URL ??= "http://localhost:1000";

import { ServiceUnavailableException } from "@nestjs/common";
import { ExitWriteService } from "./exit-write.service";
import { fnfSettlements } from "../../../db/schema";

describe("ExitWriteService.finalReview — approving a resignation via the real UI endpoint", () => {
  function buildDb(record: { id: number; orgId: string; userId: string; status: "HR_APPROVED"; lastWorkingDate: string | null; rowVersion: number }) {
    const insertedTables: unknown[] = [];
    const tx = {
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ rowVersion: record.rowVersion + 1 }]),
          }),
        })),
      })),
      insert: jest.fn().mockImplementation((table: unknown) => {
        insertedTables.push(table);
        return {
          values: jest.fn().mockImplementation((values: unknown) => ({
            onConflictDoNothing: jest.fn().mockResolvedValue([values]),
          })),
        };
      }),
    };
    const db = {
      query: {
        resignations: {
          findFirst: jest.fn().mockResolvedValue(record),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({ name: "Test Employee" }),
        },
      },
      ...tx,
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    return { db, insertedTables };
  }

  it("inserts a DRAFT fnfSettlements row and seeds the offboarding checklist on approval", async () => {
    const { db, insertedTables } = buildDb({
      id: 42,
      orgId: "org-1",
      userId: "user-1",
      status: "HR_APPROVED",
      lastWorkingDate: "2026-08-01",
      rowVersion: 1,
    });
    const resignationJobs = { notifyFinalDecision: jest.fn() };
    const exitChecklist = { seedChecklistFromTemplate: jest.fn().mockResolvedValue(undefined) };

    const service = new ExitWriteService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      resignationJobs as never,
      exitChecklist as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const result = await service.finalReview("org-1", "actor-1", 42, { decision: "approve", remarks: "ok" });

    expect(result).toEqual({ success: true });
    expect(insertedTables).toContain(fnfSettlements);
    expect(exitChecklist.seedChecklistFromTemplate).toHaveBeenCalledWith("org-1", 42);
  });

  it("does not create an FnF settlement or seed a checklist on rejection", async () => {
    const { db, insertedTables } = buildDb({
      id: 42,
      orgId: "org-1",
      userId: "user-1",
      status: "HR_APPROVED",
      lastWorkingDate: "2026-08-01",
      rowVersion: 1,
    });
    const resignationJobs = { notifyFinalDecision: jest.fn() };
    const exitChecklist = { seedChecklistFromTemplate: jest.fn() };

    const service = new ExitWriteService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      resignationJobs as never,
      exitChecklist as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await service.finalReview("org-1", "actor-1", 42, { decision: "reject", remarks: "not eligible" });

    expect(insertedTables).not.toContain(fnfSettlements);
    expect(exitChecklist.seedChecklistFromTemplate).not.toHaveBeenCalled();
  });
});

describe("ExitWriteService.update - exit completion guard", () => {
  it("does not mark the resignation completed when dependency verification fails", async () => {
    const update = jest.fn();
    const db = {
      query: {
        resignations: {
          findFirst: jest.fn().mockResolvedValue({
            id: 42,
            orgId: "org-1",
            userId: "employee-1",
            status: "IN_PROGRESS",
            rowVersion: 1,
          }),
        },
      },
      update,
    };
    const completionGuard = {
      assertReady: jest
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException("Verification unavailable"),
        ),
    };
    const service = new ExitWriteService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      completionGuard as never,
      undefined as never,
    );

    await expect(
      service.update(
        "org-1",
        { userId: "admin-1", membershipId: 1, role: "ADMIN", isApprover: true },
        42,
        { status: "COMPLETED" },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(completionGuard.assertReady).toHaveBeenCalledWith({
      orgId: "org-1",
      actorUserId: "admin-1",
      resignationId: 42,
      employeeUserId: "employee-1",
      overrideRequested: false,
      overrideReason: undefined,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
