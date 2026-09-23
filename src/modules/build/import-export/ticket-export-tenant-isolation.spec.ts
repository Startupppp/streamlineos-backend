import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.types";
import { TicketExportService } from "./ticket-export.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const PROJECT_ID = 42;

const dialect = new PgDialect();

function makeUser(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "session",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function makeDb(projectRow: unknown | null, ticketRows: unknown[] = []) {
  let capturedWhere: SQL | undefined;
  let selectCallCount = 0;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: (condition: SQL) => {
      capturedWhere = condition;
      return chain;
    },
    orderBy: () => chain,
    limit: () => Promise.resolve(ticketRows),
  });
  const db = {
    query: { projects: { findFirst: jest.fn(async () => projectRow) } },
    select: jest.fn(() => {
      selectCallCount += 1;
      return chain;
    }),
  };
  return {
    db: db as unknown as Db,
    getCapturedWhere: () => capturedWhere,
    getSelectCallCount: () => selectCallCount,
  };
}

function makeAccess() {
  return {
    resolveUserPermissions: jest.fn(async () => new Set<string>()),
    scopeFor: jest.fn(async () => "all" as const),
    holds: jest.fn(async () => true),
  } as unknown as AccessService;
}

describe("TicketExportService — cross-tenant isolation", () => {
  it("throws NotFoundException for a project that does not belong to the caller org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null);
    const svc = new TicketExportService(db, makeAccess());
    const attacker = makeUser(ATTACKER_ORG);

    await expect(
      svc.exportTickets(attacker, PROJECT_ID, { format: "csv" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("issues no ticket SELECT when the project org check fails (cross-tenant isolation prevents db leakage)", async () => {
    const { db, getSelectCallCount } = makeDb(null);
    const svc = new TicketExportService(db, makeAccess());
    const attacker = makeUser(ATTACKER_ORG);

    await expect(svc.exportTickets(attacker, PROJECT_ID, { format: "csv" })).rejects.toThrow();

    expect(getSelectCallCount()).toBe(0);
  });

  it("returns export data for the owning org (same-tenant control proving the code path is reachable)", async () => {
    const ticketRow = {
      ticketNumber: 1,
      title: "T",
      description: null,
      type: "TASK",
      status: "TODO",
      priority: "MEDIUM",
      startDate: null,
      dueDate: null,
      points: null,
      storyPoints: null,
      estimate: null,
      completionPercentage: 0,
      clientVisible: false,
      link: null,
    };
    const { db } = makeDb({ managerMembershipId: null }, [ticketRow]);
    const svc = new TicketExportService(db, makeAccess());
    const owner = makeUser(OWNER_ORG);

    const result = await svc.exportTickets(owner, PROJECT_ID, { format: "json" });

    expect(result.rowCount).toBe(1);
    expect(JSON.parse(result.content)).toHaveLength(1);
  });

  it("binds the caller's own org to the ticket WHERE clause and never the attacker org (org-scoping predicate reaches the db layer)", async () => {
    const { db, getCapturedWhere } = makeDb({ managerMembershipId: null }, []);
    const svc = new TicketExportService(db, makeAccess());
    const owner = makeUser(OWNER_ORG);

    await svc.exportTickets(owner, PROJECT_ID, { format: "csv" });

    const captured = getCapturedWhere();
    expect(captured).toBeDefined();
    const rendered = dialect.sqlToQuery(captured!);
    expect(rendered.params).toContain(OWNER_ORG);
    expect(rendered.params).not.toContain(ATTACKER_ORG);
  });
});
