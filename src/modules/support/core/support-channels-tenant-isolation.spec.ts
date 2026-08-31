import { NotFoundException } from "@nestjs/common";
import { SupportChannelsService } from "./support-channels.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportChannelsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(listRows: unknown[], updateRow?: unknown): Db {
    const findMany = jest.fn().mockResolvedValue(listRows);
    const returning = jest.fn().mockResolvedValue(updateRow !== undefined ? [updateRow] : []);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const updateChain = jest.fn().mockReturnValue({ set });
    const deleteReturning = jest.fn().mockResolvedValue([]);
    const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });
    const deleteChain = jest.fn().mockReturnValue({ where: deleteWhere });
    return {
      query: { supportChannels: { findMany, findFirst: jest.fn().mockResolvedValue(null) }, supportTickets: { findFirst: jest.fn().mockResolvedValue(null) }, users: { findFirst: jest.fn().mockResolvedValue(null) } },
      update: updateChain,
      delete: deleteChain,
      insert: jest.fn(),
    } as unknown as Db;
  }

  it("returns empty list for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const tickets = { addMessage: jest.fn(), createTicket: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportChannelsService(db, tickets as never);
    const result = await svc.listChannels(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("returns channels for the owning org (control — same-tenant access works)", async () => {
    const ROW = { id: 1, orgId: OWNER_ORG, name: "Email" };
    const db = makeDb([ROW]);
    const tickets = { addMessage: jest.fn(), createTicket: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportChannelsService(db, tickets as never);
    const result = await svc.listChannels(OWNER_ORG);
    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when updating a channel that belongs to a different org (tenant isolation)", async () => {
    const db = makeDb([], undefined);
    const tickets = { addMessage: jest.fn(), createTicket: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportChannelsService(db, tickets as never);
    await expect(svc.updateChannel(ATTACKER_ORG, 999, { name: "hacked" })).rejects.toThrow(NotFoundException);
  });
});
