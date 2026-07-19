process.env.APP_URL ??= "http://localhost:1000";

import { ExitWriteService } from "./exit-write.service";
import { fnfSettlements } from "../../db/schema";

describe("ExitWriteService.ceoReview — approving a resignation via the real UI endpoint", () => {
  function buildDb(record: { id: number; orgId: string; userId: string; status: string; lastWorkingDate: string | null }) {
    const insertedTables: unknown[] = [];
    const db = {
      query: {
        resignations: {
          findFirst: jest.fn().mockResolvedValue(record),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({ name: "Test Employee" }),
        },
      },
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation(() => ({
          where: jest.fn().mockResolvedValue(undefined),
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
    return { db, insertedTables };
  }

  it("inserts a DRAFT fnfSettlements row and seeds the offboarding checklist on approval", async () => {
    const { db, insertedTables } = buildDb({
      id: 42,
      orgId: "org-1",
      userId: "user-1",
      status: "HR_APPROVED",
      lastWorkingDate: "2026-08-01",
    });
    const resignationJobs = { notifyCeoDecision: jest.fn() };
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
      undefined as never,
    );

    const result = await service.ceoReview("org-1", "actor-1", 42, { decision: "approve", remarks: "ok" });

    expect(result).toEqual({ success: true });
    expect(insertedTables).toContain(fnfSettlements);
    expect(exitChecklist.seedChecklistFromTemplate).toHaveBeenCalledWith("org-1", 42, "actor-1");
  });

  it("does not create an FnF settlement or seed a checklist on rejection", async () => {
    const { db, insertedTables } = buildDb({
      id: 42,
      orgId: "org-1",
      userId: "user-1",
      status: "HR_APPROVED",
      lastWorkingDate: "2026-08-01",
    });
    const resignationJobs = { notifyCeoDecision: jest.fn() };
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
      undefined as never,
    );

    await service.ceoReview("org-1", "actor-1", 42, { decision: "reject", remarks: "not eligible" });

    expect(insertedTables).not.toContain(fnfSettlements);
    expect(exitChecklist.seedChecklistFromTemplate).not.toHaveBeenCalled();
  });
});
