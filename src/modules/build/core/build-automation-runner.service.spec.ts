import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { logger } from "../../../common/logger/logger.service";

jest.mock("../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

function makeRule(
  overrides: Partial<{
    id: number;
    conditions: unknown[];
    actions: unknown[];
    createdBy: string | null;
  }> = {},
) {
  return {
    id: 1,
    conditions: [],
    actions: [{ type: "set_status", value: "IN_PROGRESS" }],
    createdBy: "user-1",
    ...overrides,
  };
}

const BASE_TICKET = {
  ticketId: 10,
  projectId: 1,
  orgId: "org-1",
  status: "TODO",
  priority: "MEDIUM",
  assigneeId: null,
  title: "Fix bug",
  type: "TASK",
};

describe("BuildAutomationRunnerService", () => {
  let service: BuildAutomationRunnerService;

  const dbSelect = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };

  const dbInsert = {
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  };

  const mockSetFn = jest.fn().mockReturnThis();
  const mockWhereFn = jest.fn().mockResolvedValue(undefined);
  const mockUpdateChain = { set: mockSetFn, where: mockWhereFn };

  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
    update: jest.fn().mockReturnValue(mockUpdateChain),
    insert: jest.fn().mockReturnValue(dbInsert),
    query: {
      ticketLabels: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      projectStatuses: {
        findFirst: jest.fn().mockResolvedValue({ id: 7 }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([]);
    mockDb.update.mockReturnValue(mockUpdateChain);
    mockSetFn.mockReturnThis();
    mockWhereFn.mockResolvedValue(undefined);
    mockDb.insert.mockReturnValue(dbInsert);
    dbInsert.values.mockReturnThis();
    dbInsert.onConflictDoNothing.mockResolvedValue(undefined);
    mockDb.query.ticketLabels.findFirst.mockResolvedValue(null);
    mockDb.query.projectStatuses.findFirst.mockResolvedValue({ id: 7 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(BuildAutomationRunnerService);
  });

  function flush(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  it("fires set_status action when the status exists in the project", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue({ id: 7 });
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSetFn).toHaveBeenCalledWith(expect.objectContaining({ status: "IN_PROGRESS" }));
  });

  it("skips set_status and logs a warning when the status does not exist in the project", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue(undefined);
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "BuildAutomationRunner: set_status skipped — status does not exist in project",
      expect.objectContaining({ ruleId: 1, projectId: 1, orgId: "org-1", status: "IN_PROGRESS" }),
    );
  });

  it("does not throw when the target status is absent — the hook must not abort the transaction", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue(undefined);
    dbSelect.where.mockResolvedValue([makeRule()]);

    await expect(
      service["execute"]("org-1", 1, "ticket.created", BASE_TICKET),
    ).resolves.toBeUndefined();
  });

  it("does not fire when the rule condition does not match the ticket payload", async () => {
    dbSelect.where.mockResolvedValue([
      makeRule({
        conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
        actions: [{ type: "set_status", value: "DONE" }],
      }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", { ...BASE_TICKET, priority: "LOW" });
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not fire when the DB returns no active rules (inactive rule scenario)", async () => {
    dbSelect.where.mockResolvedValue([]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("enforces cross-tenant isolation: org-a rules never execute for org-b requests", async () => {
    dbSelect.where.mockResolvedValueOnce([makeRule()]);
    service.runForTicketEvent("org-a", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-a" });
    await flush();
    const callsAfterOrgA = mockDb.update.mock.calls.length;

    dbSelect.where.mockResolvedValueOnce([]);
    service.runForTicketEvent("org-b", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-b" });
    await flush();

    expect(callsAfterOrgA).toBe(1);
    expect(mockDb.update.mock.calls.length).toBe(1);
  });

  it("continues processing subsequent actions when one action throws", async () => {
    mockWhereFn
      .mockRejectedValueOnce(new Error("DB transient error"))
      .mockResolvedValue(undefined);

    dbSelect.where.mockResolvedValue([
      makeRule({
        actions: [
          { type: "set_status", value: "IN_PROGRESS" },
          { type: "set_status", value: "DONE" },
        ],
      }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockSetFn).toHaveBeenCalledTimes(2);
  });
});
