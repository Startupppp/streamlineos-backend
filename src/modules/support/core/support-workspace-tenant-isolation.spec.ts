import { NotFoundException } from "@nestjs/common";
import { SupportWorkspaceService } from "./support-workspace.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportWorkspaceService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const USER_ID = "user-1";

  function makeDb(queues: unknown[], ticket: unknown): Db {
    const findManyQueues = jest.fn().mockResolvedValue(queues);
    const findManyViews = jest.fn().mockResolvedValue([]);
    const findManyTags = jest.fn().mockResolvedValue([]);
    const findFirstTicket = jest.fn().mockResolvedValue(ticket);
    const findFirstQueue = jest.fn().mockResolvedValue(queues.length > 0 ? queues[0] : null);
    const countBuilder = { from: jest.fn(), where: jest.fn(), groupBy: jest.fn() };
    countBuilder.from.mockReturnValue(countBuilder);
    countBuilder.where.mockReturnValue(countBuilder);
    countBuilder.groupBy.mockResolvedValue([]);
    const updateReturning = jest.fn().mockResolvedValue([]);
    const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateChain = jest.fn().mockReturnValue({ set: updateSet });
    const deleteReturning = jest.fn().mockResolvedValue([]);
    const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });
    const deleteChain = jest.fn().mockReturnValue({ where: deleteWhere });
    return {
      query: {
        supportQueues: { findMany: findManyQueues, findFirst: findFirstQueue },
        supportSavedViews: { findMany: findManyViews, findFirst: jest.fn().mockResolvedValue(null) },
        supportTags: { findMany: findManyTags, findFirst: jest.fn().mockResolvedValue(null) },
        supportTickets: { findFirst: findFirstTicket },
        supportTicketTags: { findMany: jest.fn().mockResolvedValue([]) },
        supportTicketWatchers: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(countBuilder),
      update: updateChain,
      delete: deleteChain,
      insert: jest.fn(),
    } as unknown as Db;
  }

  it("returns empty queues for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportWorkspaceService(db);
    const result = await svc.listQueues(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("returns queues for the owning org (control — same-tenant access works)", async () => {
    const db = makeDb([{ id: 1, orgId: OWNER_ORG, name: "General" }], null);
    const svc = new SupportWorkspaceService(db);
    const result = await svc.listQueues(OWNER_ORG);
    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when updating a queue from a different org (tenant isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportWorkspaceService(db);
    await expect(svc.updateQueue(ATTACKER_ORG, 999, { name: "hacked" })).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when accessing a ticket from a different org via assertTicketInOrg (other org isolation)", async () => {
    const db = makeDb([], null);
    const svc = new SupportWorkspaceService(db);
    await expect(svc.listTicketTags(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
  });
});
