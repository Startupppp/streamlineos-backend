import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTicketNotFoundException } from "../../../../common/http/api-exceptions";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";

function makeQueryDb(row: unknown | null) {
  return {
    query: {
      tickets: {
        findFirst: jest.fn().mockResolvedValue(row),
      },
      projects: {
        findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }),
      },
    },
  } as unknown as Db;
}

describe("ProjectsTicketsDetailService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const ROW = { id: 1, orgId: OWNER_ORG, ticketNumber: 42, assigneeId: "u1", reporterId: "u1", assignees: [], comments: [], attachments: [], labels: [], project: {}, sprint: null, assignee: null, reporter: null };

  const access = { scopeFor: jest.fn().mockResolvedValue("all") };
  const audit = { log: jest.fn() };

  it("returns null/throws for a ticket belonging to a different org (cross-tenant isolation)", async () => {
    const db = makeQueryDb(null);
    const svc = new ProjectsTicketsDetailService(db, access as never, audit as never);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.getTicketByKey(u, 1, 42)).rejects.toThrow(ProjectsTicketNotFoundException);
  });

  it("returns ticket for the owning org (same-tenant control)", async () => {
    const db = makeQueryDb(ROW);
    const svc = new ProjectsTicketsDetailService(db, access as never, audit as never);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    const result = await svc.getTicketByKey(u, 1, 42);
    expect(result).toMatchObject({ id: 1 });
  });
});
