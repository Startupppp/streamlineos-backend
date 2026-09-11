import { NotFoundException } from "@nestjs/common";
import { SupportDraftsService } from "./support-drafts.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportDraftsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const USER_ID = "user-1";

  function makeDb(ticketRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(ticketRow);
    const findDraft = jest.fn().mockResolvedValue(null);
    return {
      query: {
        supportTickets: { findFirst },
        supportTicketDrafts: { findFirst: findDraft },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new SupportDraftsService(db);
    await expect(svc.getDraft(ATTACKER_ORG, 99, USER_ID, null)).rejects.toThrow(NotFoundException);
  });

  it("returns null draft when ticket belongs to the owning org (control — same-tenant access works)", async () => {
    const db = makeDb({ id: 99 });
    const svc = new SupportDraftsService(db);
    const result = await svc.getDraft(OWNER_ORG, 99, USER_ID, 7);
    expect(result).toBeNull();
  });
});
