import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Db } from "../../../../db/drizzle.module";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CacheService } from "../../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { AccessService } from "../../../access/access.service";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { projectAccessRow } from "../../__tests__/project-access-doubles";

describe("ProjectsTicketsUpdateService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(ticketRow: unknown | null) {
    return {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticketRow) }, projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } },
    } as unknown as Db;
  }

  const dispatch = { sendTicketAssignedNotification: jest.fn() } as never;
  const activity = { logTicketActivity: jest.fn(), logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never;
  const query = { authorizeMutation: jest.fn().mockResolvedValue([]), validateTicketStatus: jest.fn().mockResolvedValue(undefined) } as never;
  const transfer = { notifyAssignedTickets: jest.fn().mockResolvedValue(undefined) } as never;
  const webhooksDispatch = { dispatchTicketEvent: jest.fn(), dispatch: jest.fn().mockResolvedValue(undefined), enqueue: jest.fn().mockResolvedValue(undefined) } as never;
  const automationRunner = { run: jest.fn(), runForTicketEvent: jest.fn().mockResolvedValue(undefined) } as never;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never;
  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketsUpdateService(db, dispatch, activity, query, transfer, webhooksDispatch, automationRunner, cache, access);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.updateTicket(u, 1, 99, { version: 1 })).rejects.toThrow(NotFoundException);
  });

  it("processes ticket for the owning org (same-tenant control)", async () => {
    const ticket = { id: 1, orgId: OWNER_ORG, projectId: 1, status: "open", ticketNumber: 1, assigneeId: null, reporterId: "u1", assignees: [], version: 1 };
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([ticket]) }) }) }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    }));
    const db = {
      query: { tickets: { findFirst: jest.fn().mockResolvedValue(ticket) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
        }),
      }),
      transaction: txFn,
    } as unknown as Db;
    const ownerAccess = { holds: jest.fn().mockResolvedValue(true), scopeFor: jest.fn().mockResolvedValue("all") } as never;
    const svc = new ProjectsTicketsUpdateService(db, dispatch, activity, query, transfer, webhooksDispatch, automationRunner, cache, ownerAccess);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true, principal: { kind: "human-session", membershipId: 1, isOrgOwner: true } } as never;
    await expect(svc.updateTicket(u, 1, 1, { version: 1 })).resolves.not.toThrow();
  });

  it("rejects assignee changes without build:tickets:assign", async () => {
    const deniedHolds = jest.fn().mockResolvedValue(false);
    const module = await Test.createTestingModule({
      providers: [
        ProjectsTicketsUpdateService,
        { provide: DRIZZLE, useValue: makeDb(null) },
        ...[NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
          ProjectsTicketsReadService, ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
          BuildAutomationRunnerService, CacheService].map(provide => ({ provide, useValue: {} })),
        { provide: AccessService, useValue: { holds: deniedHolds } },
      ],
    }).compile();
    try {
      const svc = module.get(ProjectsTicketsUpdateService);
      const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;
      await expect(svc.updateTicket(u, 1, 1, { version: 1, assigneeIds: ["u2"] })).rejects.toThrow("Not authorized to assign this ticket");
      expect(module.get<Db>(DRIZZLE).query.tickets.findFirst).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });

  it("does not require build:tickets:assign for other ticket updates", async () => {
    const deniedHolds = jest.fn().mockResolvedValue(false);
    const module = await Test.createTestingModule({
      providers: [
        ProjectsTicketsUpdateService,
        { provide: DRIZZLE, useValue: makeDb(null) },
        ...[NotificationDispatchService, ProjectsActivityService, ProjectsTicketsQueryService,
          ProjectsTicketsReadService, ProjectsTicketsTransferService, ProjectsWebhooksDispatchService,
          BuildAutomationRunnerService, CacheService].map(provide => ({ provide, useValue: {} })),
        { provide: AccessService, useValue: { holds: deniedHolds } },
      ],
    }).compile();
    try {
      const svc = module.get(ProjectsTicketsUpdateService);
      const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;
      await expect(svc.updateTicket(u, 1, 1, { version: 1, title: "Renamed" })).rejects.toThrow(NotFoundException);
      expect(deniedHolds).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
