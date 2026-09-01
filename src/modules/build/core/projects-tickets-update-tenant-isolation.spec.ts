import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";

describe("ProjectsTicketsUpdateService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(ticketRow: unknown | null) {
    return {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticketRow) } },
    } as unknown as Db;
  }

  const dispatch = { sendTicketAssignedNotification: jest.fn() } as never;
  const activity = { logTicketActivity: jest.fn(), logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never;
  const query = { validateTicketStatus: jest.fn().mockResolvedValue(undefined) } as never;
  const read = { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: false, role: null }) } as never;
  const transfer = { notifyNewAssignees: jest.fn().mockResolvedValue(undefined) } as never;
  const webhooksDispatch = { dispatchTicketEvent: jest.fn(), dispatch: jest.fn().mockResolvedValue(undefined), enqueue: jest.fn().mockResolvedValue(undefined) } as never;
  const automationRunner = { run: jest.fn(), runForTicketEvent: jest.fn().mockResolvedValue(undefined) } as never;
  const cache = { invalidateNamespace: jest.fn(), del: jest.fn().mockResolvedValue(undefined) } as never;

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketsUpdateService(db, dispatch, activity, query, read, transfer, webhooksDispatch, automationRunner, cache);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.updateTicket(u, 99, {})).rejects.toThrow(NotFoundException);
  });

  it("processes ticket for the owning org (same-tenant control)", async () => {
    const ticket = { id: 1, orgId: OWNER_ORG, projectId: 1, status: "open", ticketNumber: 1, assigneeId: null, reporterId: "u1", assignees: [] };
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([ticket]) }) }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    }));
    const db = { query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } }, transaction: txFn } as unknown as Db;
    const svc = new ProjectsTicketsUpdateService(db, dispatch, activity, query, read, transfer, webhooksDispatch, automationRunner, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.updateTicket(u, 1, {})).resolves.not.toThrow();
  });
});
