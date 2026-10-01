import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { projectAccessRow } from "../project-crud/__tests__/project-access-doubles";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111", userId: "owner", role: "OWNER",
  isOrgOwner: true, sessionId: "session", tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

function projectAccessChain() {
  const rows = [projectAccessRow()];
  const chain = {
    from: jest.fn(() => chain), where: jest.fn(() => chain), limit: jest.fn().mockResolvedValue(rows),
  };
  return chain;
}

async function harness() {
  const scopeFor = jest.fn().mockResolvedValue("all");
  const rows = [{ id: 10, status: "TODO", version: 1, assigneeMembershipId: null, allowed: true }];
  const ticketChain = {
    from: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const emptyChain = {
    from: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    then: (resolve: (value: never[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) });
  let selectCount = 0;
  const db = {
    select: jest.fn(() => { selectCount++; return selectCount === 1 ? projectAccessChain() : selectCount === 2 ? ticketChain : emptyChain; }),
    update: jest.fn(() => ({ set })),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 1 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  const module = await Test.createTestingModule({ providers: [
    ProjectsTicketsQueryService,
    { provide: DRIZZLE, useValue: db },
    { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } },
    { provide: AccessService, useValue: { scopeFor } },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsActivityService, useValue: { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } },
    { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsTicketsTransferService, useValue: { notifyAssignedTickets: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  return { module, db, set, scopeFor, service: module.get(ProjectsTicketsQueryService) };
}

async function archiveAggregateHarness(blockerRows: Array<{ parentTicketId: number | null; childCount: number }>) {
  const scopeFor = jest.fn().mockResolvedValue("all");
  const rows = [{ id: 10, status: "TODO", version: 1, assigneeMembershipId: null, allowed: true }];
  const ticketChain = {
    from: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const aggregateChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    then: (resolve: (value: typeof blockerRows) => unknown) => Promise.resolve(blockerRows).then(resolve),
  };
  let selectCount = 0;
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) });
  const db = {
    select: jest.fn(() => { selectCount++; return selectCount === 1 ? projectAccessChain() : selectCount === 2 ? ticketChain : aggregateChain; }),
    update: jest.fn(() => ({ set })),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: 1 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  const module = await Test.createTestingModule({ providers: [
    ProjectsTicketsQueryService,
    { provide: DRIZZLE, useValue: db },
    { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } },
    { provide: AccessService, useValue: { scopeFor } },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsActivityService, useValue: { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } },
    { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsTicketsTransferService, useValue: { notifyAssignedTickets: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  return { module, db, set, scopeFor, service: module.get(ProjectsTicketsQueryService) };
}

describe("Build bulk assignment invariants", () => {
  it("requires build:tickets:assign before reading selected tickets", async () => {
    const h = await harness();
    h.scopeFor.mockImplementation(async (_actor: CurrentUserContext, key: string) =>
      key === "build:tickets:assign" ? "none" : "all",
    );
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], assigneeId: "member" }))
        .rejects.toThrow("Not authorized to assign tickets");
      expect(h.db.transaction).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("rejects an unknown assignee instead of silently unassigning every selected ticket", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], assigneeId: "foreign-user" }))
        .rejects.toThrow(NotFoundException);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("rejects a cycle that does not belong to this project rather than silently clearing it", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], cycleId: 999 }))
        .rejects.toThrow("Cycle not found in this project");
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("refuses to set a ticket as its own parent before any DB write", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], parentTicketId: 10 }))
        .rejects.toThrow(BadRequestException);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("rejects a parentTicketId that does not exist in this project", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], parentTicketId: 999 }))
        .rejects.toThrow("Parent ticket not found in this project");
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("rejects unknown label ids and makes no DB write, so a stale label id does not silently map to nothing", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [10], labelIds: [999] }))
        .rejects.toThrow(NotFoundException);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("returns blocked list with zero updates when a selected ticket has active children outside the selection, and no write occurs", async () => {
    const h = await archiveAggregateHarness([{ parentTicketId: 10, childCount: 1 }]);
    try {
      const result = await h.service.bulkUpdate(actor, 1, { ticketIds: [10], archive: true });
      expect(result.updated).toBe(0);
      expect(result.blocked).toEqual([
        expect.objectContaining({ ticketId: 10, dependencyCount: 1 }),
      ]);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("archive blocker count is exact when a parent has 150 active children outside the selection — aggregate over excluded children preserves full count without truncation", async () => {
    const childCount = 150;
    const h = await archiveAggregateHarness([{ parentTicketId: 10, childCount }]);
    try {
      const result = await h.service.bulkUpdate(actor, 1, { ticketIds: [10], archive: true });
      expect(result.updated).toBe(0);
      expect(result.blocked).toEqual([
        expect.objectContaining({ ticketId: 10, dependencyCount: childCount }),
      ]);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });
});
