import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";

describe("ProjectsTicketsUpdateService — sprintId bridge", () => {
  const ORG = "org-1";
  const LEGACY_SPRINT_ID = 7;
  const CYCLE_ID = 42;
  const TICKET_ID = 1;
  const PROJECT_ID = 10;

  const baseTicket = {
    id: TICKET_ID,
    orgId: ORG,
    projectId: PROJECT_ID,
    status: "TODO",
    title: "t",
    priority: "MEDIUM",
    type: "TASK",
    assigneeMembershipId: null,
    cycleId: null,
    startDate: null,
    dueDate: null,
    reporterId: "u1",
    updatedAt: new Date(),
    points: null,
    version: 0,
    assignee: null,
  };

  const activity = {
    logTicketFieldChanges: jest.fn().mockResolvedValue(undefined),
  } as never;
  const query = { authorizeMutation: jest.fn().mockResolvedValue(undefined) } as never;
  const read = {
    checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" }),
  } as never;
  const transfer = { notifyNewAssignees: jest.fn().mockResolvedValue(undefined) } as never;
  const webhooksDispatch = { enqueue: jest.fn().mockResolvedValue(undefined) } as never;
  const automationRunner = { runForTicketEvent: jest.fn().mockResolvedValue(undefined) } as never;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(true) } as never;
  const dispatch = {} as never;

  const u = {
    orgId: ORG,
    userId: "u1",
    isOrgOwner: true,
    principal: { kind: "human-session", isOrgOwner: true },
  } as never;

  it("bridges input sprintId to cycleId — writes cycleId to the ticket row and never writes sprintId", async () => {
    let capturedSet: Record<string, unknown> | undefined;

    const tx = {
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((data: Record<string, unknown>) => {
          capturedSet = data;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: TICKET_ID }]),
            }),
          };
        }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    let selectCallCount = 0;
    const db = {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(baseTicket) } },
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ id: CYCLE_ID }]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        };
      }),
    } as unknown as Db;

    const svc = new ProjectsTicketsUpdateService(
      db,
      dispatch,
      activity,
      query,
      read,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );

    await svc.updateTicket(u, PROJECT_ID, TICKET_ID, { sprintId: LEGACY_SPRINT_ID });

    expect(capturedSet).toBeDefined();
    expect(capturedSet).toMatchObject({ cycleId: CYCLE_ID });
    expect(capturedSet).not.toHaveProperty("sprintId");
  });

  it("rejects an unmappable sprintId instead of silently ignoring the assignment", async () => {
    const db = {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(baseTicket) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ProjectsTicketsUpdateService(
      db,
      dispatch,
      activity,
      query,
      read,
      transfer,
      webhooksDispatch,
      automationRunner,
      cache,
      access,
    );

    await expect(
      svc.updateTicket(u, PROJECT_ID, TICKET_ID, { sprintId: 999 }),
    ).rejects.toThrow(BadRequestException);
  });
});
