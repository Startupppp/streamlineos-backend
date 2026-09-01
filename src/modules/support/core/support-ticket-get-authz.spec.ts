/**
 * Regression specs for the GET /support/:supportTicketId BOLA gap.
 *
 * Before the fix, getTicket() only checked orgId, so any holder of
 * support:tickets:view with "own" scope (only sees their assigned tickets
 * in the list) could fetch any org ticket by numeric ID.
 *
 * After the fix, getTicket() accepts an optional actor+scope arg and
 * throws ForbiddenException when scope is not "all" and the ticket
 * assignee does not match the actor.
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
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
  assigneeId,
  creatorId: ASSIGNEE_USER,
  createdAt: new Date(),
  updatedAt: new Date(),
  client: null,
  assignee: assigneeId ? { id: assigneeId, name: "User", image: null } : null,
  creator: { id: ASSIGNEE_USER, name: "Creator" },
  messages: [],
});

function makeDb(ticket: ReturnType<typeof makeTicket> | null): Db {
  return {
    query: {
      supportTickets: {
        findFirst: jest.fn().mockResolvedValue(ticket),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
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
  return { userId, scope };
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
