import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-1";
const PROJECT_ID = 42;

describe("ProjectsTicketsQueryService.assertTransitionAllowed — fail-open enforcement", () => {
  let svc: ProjectsTicketsQueryService;
  let mockDb: Record<string, unknown>;

  function makeSelectTransitions(rows: { fromStatusId: number | null; toStatusId: number }[]) {
    return jest.fn().mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    });
  }

  function makeSelectStatuses(rows: { id: number; name: string }[]) {
    return jest.fn().mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    });
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        ProjectsTicketsQueryService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    svc = module.get(ProjectsTicketsQueryService);
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "IN_PROGRESS"),
    ).resolves.toBeUndefined();
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "UNKNOWN_STATUS", "IN_PROGRESS"),
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "NONEXISTENT_STATUS"),
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "DONE"),
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "DONE"),
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "IN_PROGRESS"),
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "Backlog", "Review"),
    ).rejects.toThrow(/Backlog.*Review|Review.*Backlog/i);
  });

  it("ALLOWS (no throw, swallows error) when any unexpected DB error is thrown", async () => {
    (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockRejectedValue(new Error("DB connection refused")),
        }),
      };
    });

    await expect(
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "TODO", "DONE"),
    ).resolves.toBeUndefined();
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

    const err = await svc
      .assertTransitionAllowed(ORG_ID, PROJECT_ID, "Open", "Blocked")
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
      svc.assertTransitionAllowed(ORG_ID, PROJECT_ID, "Start", "Middle"),
    ).resolves.toBeUndefined();
  });
});
