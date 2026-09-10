// GET /support/:supportTicketId once checked only orgId, so an "own"-scoped holder could fetch any org ticket by id. The scope is now in the predicate, and this double answers it the way the database would.

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { ScopedRead } from "../../access/scoped-read";
import { SupportTicketsService } from "./support-tickets.service";

const ORG = "org-authz-test";
const ASSIGNEE_USER = "user-assignee";
const OTHER_USER = "user-other";
const TICKET_ID = 77;

const makeTicket = (assigneeId: string | null = ASSIGNEE_USER) => ({
  id: TICKET_ID,
  orgId: ORG,
  title: "Test ticket",
  status: "OPEN",
  priority: "MEDIUM",
  client: null,
  assigneeMembership: assigneeId ? { user: { id: assigneeId } } : null,
  creatorMembership: { user: { id: ASSIGNEE_USER } },
  messages: [],
});

const dialect = new PgDialect();

// The scoped read narrows by assignee membership; the existence fallback does not. This double answers each the way Postgres would.
function makeDb(ticket: ReturnType<typeof makeTicket> | null): Db {
  const findFirst = jest.fn().mockImplementation((args: { where: SQL }) => {
    if (ticket === null) return Promise.resolve(null);
    const rendered = dialect.sqlToQuery(args.where);
    const narrowed = rendered.sql.includes("organization_members");
    if (!narrowed) return Promise.resolve(ticket);
    const assignee = ticket.assigneeMembership?.user?.id ?? null;
    return Promise.resolve(rendered.params.includes(assignee) ? ticket : null);
  });
  return {
    query: { supportTickets: { findFirst, findMany: jest.fn().mockResolvedValue([]) } },
  } as unknown as Db;
}

const noop = {} as never;

function makeService(ticket: ReturnType<typeof makeTicket> | null): SupportTicketsService {
  const db = makeDb(ticket);
  const customFields = { getFieldValues: jest.fn().mockResolvedValue([]) };
  return new SupportTicketsService(
    db,
    noop, // cache
    noop, // planLimits
    noop, // macros
    noop, // notifications
    noop, // realtime
    noop, // sla
    noop, // automations
    noop, // ai
    customFields as never,
    noop, // activity
    noop, // messages
    noop, // operations
  );
}

function actor(userId: string, scope: DataScope) {
  return ScopedRead.of(ORG, userId, scope);
}

describe("SupportTicketsService.getTicket — scope gate", () => {
  it("returns the ticket when scope is 'all' regardless of assignee", async () => {
    const svc = makeService(makeTicket(ASSIGNEE_USER));
    const result = await svc.getTicket(ORG, TICKET_ID, actor(OTHER_USER, "all"));
    expect(result.id).toBe(TICKET_ID);
  });

  it("returns the ticket when scope is 'own' and the actor is the assignee", async () => {
    const svc = makeService(makeTicket(ASSIGNEE_USER));
    const result = await svc.getTicket(ORG, TICKET_ID, actor(ASSIGNEE_USER, "own"));
    expect(result.id).toBe(TICKET_ID);
  });

  it("throws ForbiddenException when scope is 'own' and actor is NOT the assignee — BOLA gate bites", async () => {
    const svc = makeService(makeTicket(ASSIGNEE_USER));
    await expect(
      svc.getTicket(ORG, TICKET_ID, actor(OTHER_USER, "own")),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when scope is 'team' and actor is NOT the assignee — BOLA gate bites", async () => {
    const svc = makeService(makeTicket(ASSIGNEE_USER));
    await expect(
      svc.getTicket(ORG, TICKET_ID, actor(OTHER_USER, "team")),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when scope is 'none'", async () => {
    const svc = makeService(makeTicket(ASSIGNEE_USER));
    await expect(
      svc.getTicket(ORG, TICKET_ID, actor(OTHER_USER, "none")),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws NotFoundException when the ticket does not exist in the org", async () => {
    const svc = makeService(null);
    await expect(
      svc.getTicket(ORG, TICKET_ID, actor(ASSIGNEE_USER, "all")),
    ).rejects.toThrow(NotFoundException);
  });

  it("requires an actor argument, so an unscoped read is unrepresentable rather than merely discouraged", () => {
    expect(SupportTicketsService.prototype.getTicket.length).toBe(3);
  });
});
