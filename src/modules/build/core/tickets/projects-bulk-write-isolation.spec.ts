import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { organizationMembers, projectMembers, projectStatuses, tickets, workflowTransitions } from "../../../../db/schema";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111", userId: "owner", role: "OWNER",
  isOrgOwner: true, sessionId: "session", tokenScopes: null, principal: humanSessionPrincipal(1, true),
};

async function harness(size = 1, allowed = true, missingProject = false) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: i + 1, status: "TODO", version: 1, allowed,
    rank: String((i + 1) * 1000), assigneeMembershipId: null, dueDate: null, priority: "MEDIUM", points: null, epicId: null, sprintId: null,
  }));
  const statuses: Array<{ id: number; name: string; wipLimit: number | null }> = [{ id: 1, name: "TODO", wipLimit: null }, { id: 2, name: "DONE", wipLimit: null }];
  const occupancy = { count: 0 };
  const transitions: Array<{ fromStatusId: number; toStatusId: number; requiredFields: string[]; requiresApproval: boolean; allowedRoles: string[] }> = [];
  const select = jest.fn((selection: Record<string, unknown>) => {
    let data: unknown = rows;
    const chain: {
      from: jest.Mock; where: jest.Mock; orderBy: jest.Mock; for: jest.Mock;
      innerJoin: jest.Mock; limit: jest.Mock;
      then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
    } = {
      from: jest.fn((table: unknown) => {
        data = table === tickets ? ("count" in selection ? [occupancy] : rows) : table === projectStatuses ? statuses : table === workflowTransitions ? transitions : table === organizationMembers || table === projectMembers ? [{ userId: "member", membershipId: 9, id: 9 }] : [];
        return chain;
      }),
      where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), for: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(), limit: jest.fn(() => Promise.resolve(data)),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(data).then(resolve),
    };
    return chain;
  });
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) });
  const values = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const db = { select, update: jest.fn(() => ({ set })), insert: jest.fn(() => ({ values })), delete: remove,
    execute: jest.fn(async () => statuses.map(status => ({ name: status.name, wip_limit: status.wipLimit, current_count: occupancy.count, status_exists: true, has_statuses: true }))), transaction: jest.fn(),
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(missingProject ? undefined : { id: 1 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 9 }) },
    },
  };
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  const module = await Test.createTestingModule({ providers: [ProjectsTicketsQueryService,
    { provide: DRIZZLE, useValue: db }, { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } },
    { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue("all"), resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
    { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
    { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsActivityService, useValue: { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } },
    { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    { provide: ProjectsTicketsTransferService, useValue: { notifyAssignedTickets: jest.fn().mockResolvedValue(undefined) } },
  ] }).compile();
  return { module, db, rows, statuses, occupancy, transitions, set, values, service: module.get(ProjectsTicketsQueryService) };
}

describe("Build bulk mutations: fail-whole authorization and fixed query budgets", () => {
  it("returns404 for a foreign project before checking membership", async () => {
    const h = await harness(1, true, true);
    try {
      await expect(h.service.bulkUpdate({ ...actor, isOrgOwner: false }, 99, { ticketIds: [1], priority: "HIGH" })).rejects.toThrow(NotFoundException);
      expect(h.db.select).not.toHaveBeenCalled();
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("rejects a mixed tenant batch without any update", async () => {
    const h = await harness();
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [1, 999], priority: "HIGH" })).rejects.toThrow(NotFoundException);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("returns403 for a same-tenant ticket outside DataScope", async () => {
    const h = await harness(1, false);
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [1], priority: "HIGH" })).rejects.toThrow(ForbiddenException);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it.each([1, 100])("updates %i assignments with one lookup, one effect-metadata read, one update, and two link writes — the read count does not grow with the batch", async (size) => {
    const h = await harness(size);
    try {
      const result = await h.service.bulkUpdate(actor, 1, { ticketIds: h.rows.map((row) => row.id), assigneeId: "member" });
      expect(result.updated).toBe(size);
      expect(h.db.select).toHaveBeenCalledTimes(3);
      expect(h.db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
      expect(h.set).toHaveBeenCalledTimes(1);
      expect(h.set).toHaveBeenCalledWith(expect.objectContaining({ assigneeMembershipId: 9 }));
      expect(h.set).toHaveBeenCalledWith(expect.not.objectContaining({ version: expect.anything() }));
      expect(h.db.delete).toHaveBeenCalledTimes(1);
      expect(h.values).toHaveBeenCalledTimes(1);
      expect(h.values.mock.calls[0]?.[0]).toHaveLength(size);
    } finally { await h.module.close(); }
  });

  it("validates required fields from the batched read and does not query each ticket", async () => {
    const h = await harness(100);
    h.transitions.push({ fromStatusId: 1, toStatusId: 2, requiredFields: ["dueDate"], requiresApproval: false, allowedRoles: [] });
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: h.rows.map((row) => row.id), status: "DONE" })).rejects.toThrow(BadRequestException);
      expect(h.db.select).toHaveBeenCalledTimes(3);
      expect(h.set).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it.each([1, 100])("writes %i status events in one outbox insert and reads effect metadata once", async (size) => {
    const h = await harness(size);
    try {
      await h.service.bulkUpdate(actor, 1, { ticketIds: h.rows.map((row) => row.id), status: "DONE" });
      expect(h.db.select).toHaveBeenCalledTimes(4);
      expect(h.values).toHaveBeenCalledTimes(1);
      expect(h.values.mock.calls[0]?.[0]).toHaveLength(size);
    } finally { await h.module.close(); }
  });

  it("counts the whole incoming batch against WIP before any write", async () => {
    const h = await harness(2);
    const done = h.statuses.find((status) => status.name === "DONE");
    if (!done) throw new Error("Missing status fixture");
    done.wipLimit = 3;
    h.occupancy.count = 2;
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: [1, 2], status: "DONE" })).rejects.toThrow(ConflictException);
      expect(h.db.select).toHaveBeenCalledTimes(3);
      expect(h.set).not.toHaveBeenCalled();
      expect(h.db.execute).toHaveBeenCalledTimes(3);
      expect(h.db.execute.mock.invocationCallOrder[0]).toBeLessThan(h.db.select.mock.invocationCallOrder[0] ?? Infinity);
    } finally { await h.module.close(); }
  });

  it("accepts exactly remaining WIP capacity with one aggregate query", async () => {
    const h = await harness(100);
    const done = h.statuses.find((status) => status.name === "DONE");
    if (!done) throw new Error("Missing status fixture");
    done.wipLimit = 101;
    h.occupancy.count = 1;
    try {
      await expect(h.service.bulkUpdate(actor, 1, { ticketIds: h.rows.map((row) => row.id), status: "DONE" })).resolves.toMatchObject({ updated: 100 });
      expect(h.db.select).toHaveBeenCalledTimes(4);
      expect(h.db.execute).toHaveBeenCalledTimes(3);
    } finally { await h.module.close(); }
  });
});
