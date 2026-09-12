import { ScopedRead } from "../../access/scoped-read";
import { NotFoundException } from "@nestjs/common";
import { SupportIntegrationsService } from "./support-integrations.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportIntegrationsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(ticketRow: unknown, linksRows: unknown[] = []): Db {
    const findFirstTicket = jest.fn().mockResolvedValue(ticketRow);
    const findManyLinks = jest.fn().mockResolvedValue(linksRows);
    return {
      query: {
        supportTickets: { findFirst: findFirstTicket },
        supportTicketExternalLinks: { findMany: findManyLinks },
        projects: { findFirst: jest.fn().mockResolvedValue(null) },
        invoices: { findFirst: jest.fn().mockResolvedValue(null) },
        calendarEvents: { findFirst: jest.fn().mockResolvedValue(null) },
        chatChannels: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn(),
      delete: jest.fn(),
    } as unknown as Db;
  }

  it("throws NotFoundException for a ticket owned by a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new SupportIntegrationsService(db);
    await expect(svc.listLinks(ATTACKER_ORG, 99, ScopedRead.of(ATTACKER_ORG, "user-attacker", "all"))).rejects.toThrow(NotFoundException);
  });

  it("returns links for the owning org (control — same-tenant access works)", async () => {
    const db = makeDb({ id: 99 }, [{ id: 1, orgId: OWNER_ORG }]);
    const svc = new SupportIntegrationsService(db);
    const result = await svc.listLinks(OWNER_ORG, 99, ScopedRead.of(OWNER_ORG, "user-owner", "all"));
    expect(result).toHaveLength(1);
  });
});
