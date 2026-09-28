import { BadRequestException } from "@nestjs/common";
import { assertTransitionAllowed } from "./projects-tickets-workflow-utils";
import type { Db } from "../../../../db/drizzle.module";

const ORG_ID = "org-1";
const PROJECT_ID = 42;
const TEST_CONTEXT = {
  userId: "user-1",
  userProjectRole: null,
  isOrgOwner: false,
  ticketId: 1,
};

describe("assertTransitionAllowed — fail-open enforcement", () => {
  let mockDb: { select: jest.Mock; query: Record<string, unknown> };

  beforeEach(() => {
    jest.resetAllMocks();
    mockDb = {
      select: jest.fn(),
      query: {},
    };
  });

  it("ALLOWS (no throw) when there are zero workflow_transitions for the project", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "IN_PROGRESS", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });

  it("propagates a database failure instead of treating the workflow as unrestricted", async () => {
    mockDb.select.mockImplementation(() => { throw new Error("database unavailable"); });
    await expect(assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "DONE", TEST_CONTEXT))
      .rejects.toThrow("database unavailable");
  });

  it("ALLOWS (no throw) when fromText cannot be mapped to a projectStatuses id", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ fromStatusId: 1, toStatusId: 2 }]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 2, name: "IN_PROGRESS" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "UNKNOWN_STATUS", "IN_PROGRESS", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });

  it("ALLOWS (no throw) when toText cannot be mapped to a projectStatuses id", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ fromStatusId: 1, toStatusId: 2 }]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 1, name: "TODO" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "NONEXISTENT_STATUS", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });

  it("ALLOWS (no throw) when a matching specific transition exists (from→to)", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: 10, toStatusId: 20 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 10, name: "TODO" },
            { id: 20, name: "DONE" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "DONE", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });

  it("ALLOWS (no throw) when a wildcard transition exists (fromStatusId=null, any→to)", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: null, toStatusId: 20 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 10, name: "TODO" },
            { id: 20, name: "DONE" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "DONE", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });

  it("THROWS 400 when transitions exist but none matches the from→to pair", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: 10, toStatusId: 30 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 10, name: "TODO" },
            { id: 20, name: "IN_PROGRESS" },
            { id: 30, name: "DONE" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "IN_PROGRESS", TEST_CONTEXT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("THROWS 400 with a descriptive message containing from/to status names", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: 1, toStatusId: 3 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 1, name: "Backlog" },
            { id: 2, name: "Review" },
            { id: 3, name: "Closed" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "Backlog", "Review", TEST_CONTEXT),
    ).rejects.toThrow(/Backlog.*Review|Review.*Backlog/i);
  });

  it("DENIES rather than swallowing an unexpected database error", async () => {
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockRejectedValue(new Error("DB connection refused")),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "TODO", "DONE", TEST_CONTEXT),
    ).rejects.toThrow("DB connection refused");
  });

  it("does NOT swallow BadRequestException — rethrows it", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: 5, toStatusId: 6 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 5, name: "Open" },
            { id: 6, name: "Closed" },
            { id: 7, name: "Blocked" },
          ]),
        }),
      };
    });

    const err = await assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "Open", "Blocked", TEST_CONTEXT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("ALLOWS (no throw) when transitions list has entries but both statuses resolve and a wildcard covers the destination", async () => {
    let callCount = 0;
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { fromStatusId: 1, toStatusId: 3 },
              { fromStatusId: null, toStatusId: 2 },
            ]),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 1, name: "Start" },
            { id: 2, name: "Middle" },
            { id: 3, name: "End" },
          ]),
        }),
      };
    });

    await expect(
      assertTransitionAllowed(mockDb as unknown as Db, ORG_ID, PROJECT_ID, "Start", "Middle", TEST_CONTEXT),
    ).resolves.toBeUndefined();
  });
});
