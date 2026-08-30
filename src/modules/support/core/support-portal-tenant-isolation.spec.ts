import { NotFoundException } from "@nestjs/common";
import { SupportPortalService } from "./support-portal.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportPortalService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const USER_ID = "user-1";

  function makeDb(listRows: unknown[], singleRow: unknown): Db {
    const findMany = jest.fn().mockResolvedValue(listRows);
    const findFirst = jest.fn().mockResolvedValue(singleRow);
    return {
      query: {
        supportTickets: { findMany, findFirst },
      },
    } as unknown as Db;
  }

  it("returns empty list for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([], null);
    const tickets = { createTicket: jest.fn(), addMessage: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportPortalService(db, tickets as never);
    const result = await svc.listMyTickets(ATTACKER_ORG, USER_ID);
    expect(result).toHaveLength(0);
  });

  it("returns tickets for the owning org and user (control — same-tenant access works)", async () => {
    const db = makeDb([{ id: 1, orgId: OWNER_ORG, createdBy: USER_ID }], null);
    const tickets = { createTicket: jest.fn(), addMessage: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportPortalService(db, tickets as never);
    const result = await svc.listMyTickets(OWNER_ORG, USER_ID);
    expect(result).toHaveLength(1);
  });

  it("throws NotFoundException when getting a ticket that belongs to a different org (tenant isolation)", async () => {
    const db = makeDb([], null);
    const tickets = { createTicket: jest.fn(), addMessage: jest.fn(), listPublicMessages: jest.fn() };
    const svc = new SupportPortalService(db, tickets as never);
    await expect(svc.getMyTicket(ATTACKER_ORG, USER_ID, 99)).rejects.toThrow(NotFoundException);
  });
});
