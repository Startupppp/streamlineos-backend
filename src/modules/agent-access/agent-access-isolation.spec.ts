/**
 * AgentAccessService reads tickets, projects and related records scoped by orgId.
 * Cross-tenant isolation: org A cannot read tickets owned by org B because every
 * query includes eq(tickets.orgId, orgId). A cross-org ticket id returns 404 (not 403).
 */

import { NotFoundException } from "@nestjs/common";
import { AgentAccessService } from "./agent-access.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(ticketRow: unknown): Db {
  return {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue(ticketRow) },
      users: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;
}

describe("AgentAccessService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("throws NotFoundException when ticket belongs to a different org (cross-tenant: attacker org cannot see owner org ticket)", async () => {
    const db = makeDb(null);
    const svc = new AgentAccessService(db);

    await expect(
      svc.resolveTicketOrgScoped(ATTACKER_ORG, 42),
    ).rejects.toThrow(NotFoundException);
  });

  it("resolves the ticket for the owning org (control — same-tenant access works)", async () => {
    const db = makeDb({ id: 42, projectId: "proj-1" });
    const svc = new AgentAccessService(db);

    const result = await svc.resolveTicketOrgScoped(OWNER_ORG, 42);

    expect(result).toMatchObject({ id: 42, projectId: "proj-1" });
  });
});
