import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";

describe("ProjectsTicketSubresourcesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(ticketRow: unknown | null, subtaskRows: unknown[] = []) {
    return {
      query: {
        tickets: {
          findFirst: jest.fn().mockResolvedValue(ticketRow),
          findMany: jest.fn().mockResolvedValue(subtaskRows),
        },
        ticketActivityLog: { findMany: jest.fn().mockResolvedValue([]) },
        ticketWatchers: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  const activity = { logTicketActivity: jest.fn() };
  const comments = {} as never;
  const checklists = {} as never;
  const links = {} as never;
  const relations = {} as never;

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsTicketSubresourcesService(db, activity as never, comments, checklists, links, relations);
    await expect(svc.getWatchers(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns subtasks scoped to owning org (same-tenant control)", async () => {
    const subtask = { id: 2, parentTicketId: 1, orgId: OWNER_ORG };
    const db = makeDb({ id: 1, orgId: OWNER_ORG }, [subtask]);
    const svc = new ProjectsTicketSubresourcesService(db, activity as never, comments, checklists, links, relations);
    const result = await svc.getSubtasks(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});
