import { Test, type TestingModule } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import { HrAuditService } from "../core/hr-audit.service";
import { KnowledgeAuthorizationService } from "../../kb/core/authorization/knowledge-authorization.service";
import type { SupportActor } from "./lib/support-queues";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KbActorStanding } from "../../kb/core/authorization/knowledge-authorization.types";

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(async (_db: unknown, orgId: string, ref: { userId: string }) => ({
    orgId,
    userId: ref.userId,
    membershipId: ref.userId === "user1" ? 11 : 7,
  })),
  OrganizationActorError: class OrganizationActorError extends Error {},
  organizationActorHttpError: (e: Error) => e,
}));

const makeTicket = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  orgId: "org1",
  userId: "user1",
  userMembershipId: 11,
  title: "Need help",
  description: "Please assist",
  category: "other",
  queue: "ADMIN" as const,
  priority: "MEDIUM" as const,
  status: "TODO" as const,
  assigneeId: null,
  assigneeMembershipId: null,
  assigneeName: null,
  isConfidential: false,
  firstResponseDueAt: null,
  firstRespondedAt: null,
  slaDueAt: null,
  escalatedAt: null,
  escalationLevel: 0,
  resolvedAt: null,
  resolution: null,
  createdAt: new Date("2024-01-01T12:00:00Z"),
  updatedAt: new Date("2024-01-01T12:00:00Z"),
  authorName: "Alice",
  authorImage: null,
  ...overrides,
});

const actor = (overrides: Partial<SupportActor> = {}): SupportActor => ({
  orgId: "org1",
  userId: "agent1",
  membershipId: 7,
  isAdmin: false,
  queues: new Set(["IT"]),
  ...overrides,
});

const mockTx = {
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([makeTicket()]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
};

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  orderBy: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
  query: {
    helpdeskTickets: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
  transaction: jest.fn(),
};

const mockConfig = {
  routingRuleFor: jest.fn().mockResolvedValue(null),
  slaFor: jest.fn().mockResolvedValue({ firstResponseHours: 4, resolutionHours: 24 }),
};

const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };

const mockStanding: KbActorStanding = {
  orgId: "org1",
  userId: "agent1",
  membershipId: 7,
  roleSlugs: [],
  isOrgOwner: false,
  isKbAdmin: false,
  accessibleSpaceIds: [],
  accessibleProjectIds: [],
  permissionsVersion: 1,
};

const mockAuth = {
  resolveStanding: jest.fn().mockResolvedValue(mockStanding),
};

const testUser: CurrentUserContext = {
  userId: "agent1",
  orgId: "org1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
};

const dialect = new PgDialect();

function lastWhereSql() {
  const call = mockDb.where.mock.calls.at(-1);
  if (!call) throw new Error("no where clause captured");
  const [clause] = call;
  return dialect.sqlToQuery(clause);
}

describe("HrHelpdeskService", () => {
  let service: HrHelpdeskService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.orderBy.mockReturnThis();
    mockDb.execute.mockResolvedValue([]);
    mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(null);

    mockTx.insert.mockReturnThis();
    mockTx.values.mockReturnThis();
    mockTx.returning.mockResolvedValue([makeTicket()]);
    mockTx.update.mockReturnThis();
    mockTx.set.mockReturnThis();
    mockTx.where.mockReturnThis();

    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
    mockConfig.routingRuleFor.mockResolvedValue(null);
    mockConfig.slaFor.mockResolvedValue({ firstResponseHours: 4, resolutionHours: 24 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrHelpdeskService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrHelpdeskConfigService, useValue: mockConfig },
        { provide: HrAuditService, useValue: mockAudit },
        { provide: KnowledgeAuthorizationService, useValue: mockAuth },
      ],
    }).compile();

    service = module.get(HrHelpdeskService);
  });

  describe("list — cursor pagination", () => {
    it("returns a cursor page without repeating the boundary row", async () => {
      mockDb.limit.mockResolvedValueOnce([
        makeTicket({ id: 3, createdAt: new Date("2024-01-03T00:00:00Z") }),
        makeTicket({ id: 2, createdAt: new Date("2024-01-02T00:00:00Z") }),
        makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }),
      ]);

      const result = await service.list(actor({ isAdmin: true }), { limit: 2, cursor: undefined });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({ id: 3 });
      expect(result.data[1]).toMatchObject({ id: 2 });
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.nextCursor).not.toBeNull();
    });

    it("page 2 uses the cursor from page 1 and does not repeat the boundary row", async () => {
      mockDb.limit.mockResolvedValueOnce([
        makeTicket({ id: 3, createdAt: new Date("2024-01-03T00:00:00Z") }),
        makeTicket({ id: 2, createdAt: new Date("2024-01-02T00:00:00Z") }),
        makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }),
      ]);
      const page1 = await service.list(actor({ isAdmin: true }), { limit: 2, cursor: undefined });

      mockDb.limit.mockResolvedValueOnce([makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") })]);
      const page2 = await service.list(actor({ isAdmin: true }), {
        limit: 2,
        cursor: page1.pagination.nextCursor ?? undefined,
      });

      expect(page2.data).toHaveLength(1);
      expect(page2.data[0]).toMatchObject({ id: 1 });
      expect(page2.pagination.hasMore).toBe(false);
      const page1Ids = new Set(page1.data.map((r) => r.id));
      for (const row of page2.data) expect(page1Ids.has(row.id)).toBe(false);
    });

    it("returns empty last page when no more rows exist", async () => {
      mockDb.limit.mockResolvedValue([makeTicket({ id: 1 })]);

      const result = await service.list(actor({ isAdmin: true }), { limit: 2, cursor: undefined });
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.nextCursor).toBeNull();
    });
  });

  describe("list — visibility predicate", () => {
    it("a queue member's read is fenced to their queues, their own requests, and non-confidential requests", async () => {
      await service.list(actor({ queues: new Set(["IT", "FINANCE"]) }), { limit: 20, cursor: undefined });

      const built = lastWhereSql();
      expect(built.sql).toContain('"helpdesk_tickets"."queue" in');
      expect(built.sql).toContain('"helpdesk_tickets"."user_id"');
      expect(built.sql).toContain('"helpdesk_tickets"."is_confidential"');
      expect(built.params).toEqual(expect.arrayContaining(["org1", "agent1", "IT", "FINANCE"]));
    });

    it("an agent who is a member of no queue reads only own and non-confidential requests, never a queue", async () => {
      await service.list(actor({ queues: new Set() }), { limit: 20, cursor: undefined });

      const built = lastWhereSql();
      expect(built.sql).not.toContain('"helpdesk_tickets"."queue" in');
      expect(built.sql).toContain('"helpdesk_tickets"."is_confidential"');
      expect(built.params).toContain("agent1");
    });

    it("the queue filter narrows within the visibility fence rather than replacing it", async () => {
      await service.list(actor({ queues: new Set(["IT"]) }), { limit: 20, cursor: undefined, queue: "LEGAL" });

      const built = lastWhereSql();
      expect(built.params.filter((param) => param === "LEGAL")).toHaveLength(1);
      expect(built.params).toContain("IT");
    });

    it("the employee's own list is keyed on the requester alone", async () => {
      await service.listMine("org1", "user1", { limit: 20, cursor: undefined });

      const built = lastWhereSql();
      expect(built.sql).toContain('"helpdesk_tickets"."user_id"');
      expect(built.sql).not.toContain('"helpdesk_tickets"."queue"');
      expect(built.params).toEqual(expect.arrayContaining(["org1", "user1"]));
    });
  });

  describe("list — search cap+1 fallback", () => {
    async function searchWhere(probeRowCount: number) {
      mockDb.execute.mockResolvedValueOnce(Array.from({ length: probeRowCount }, (_, i) => ({ id: i + 1 })));
      await service.list(actor({ isAdmin: true }), { limit: 20, cursor: undefined, q: "help" });
      return lastWhereSql();
    }

    it("asks the probe for one more row than the cap, so the cap is detectable", async () => {
      await searchWhere(3);

      const probe = mockDb.execute.mock.calls.at(-1);
      if (!probe) throw new Error("no probe captured");
      const [probeSql] = probe;
      expect(dialect.sqlToQuery(probeSql).sql).toContain("app.search_helpdesk_ticket_ids");
      expect(dialect.sqlToQuery(probeSql).params).toEqual(["help", 501]);
    });

    it("filters on the ids the probe returned, never on the raw text", async () => {
      const built = await searchWhere(3);

      expect(built.sql).toContain('"helpdesk_tickets"."id" in');
      expect(built.sql).not.toMatch(/ilike/i);
      expect(built.params).toEqual(expect.arrayContaining([1, 2, 3]));
    });

    it("returns nothing without scanning when the probe finds no match", async () => {
      const built = await searchWhere(0);

      expect(built.sql).toContain("false");
      expect(built.sql).not.toMatch(/ilike/i);
    });

    it("falls back to ILIKE only past the cap, where the id list stops paying for itself", async () => {
      const built = await searchWhere(502);

      expect(built.sql).toMatch(/ilike/i);
      expect(built.params).toContain("%help%");
    });
  });

  describe("getById", () => {
    it("answers 404, never 403, for a confidential request outside the agent's queues", async () => {
      mockDb.limit.mockResolvedValueOnce([makeTicket({ queue: "HR", isConfidential: true, userId: "someone-else" })]);

      await expect(service.getById(actor({ queues: new Set(["IT"]) }), 1)).rejects.toThrow(NotFoundException);
    });

    it("answers 404 for a request in another tenant", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(service.getById(actor({ orgId: "org-attacker", isAdmin: true }), 1)).rejects.toThrow(NotFoundException);
      const built = lastWhereSql();
      expect(built.params).toContain("org-attacker");
    });
  });

  describe("create — routing and SLA stamping", () => {
    beforeEach(() => {
      mockDb.limit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeTicket({ id: 42 })])
        .mockResolvedValue([]);
      mockTx.returning.mockResolvedValue([{ id: 42 }]);
    });

    it("routes by the default category table, stamps both SLA due dates and audits inside the transaction", async () => {
      await service.create("org1", "user1", {
        title: "Laptop will not boot",
        category: "equipment",
        priority: "HIGH",
      });

      expect(mockConfig.slaFor).toHaveBeenCalledWith("org1", "IT");
      const insertValues = mockTx.values.mock.calls[0]?.[0];
      expect(insertValues).toMatchObject({
        queue: "IT",
        isConfidential: false,
        userMembershipId: 11,
        assigneeId: null,
        assigneeMembershipId: null,
      });
      expect(insertValues.firstResponseDueAt.getTime() - insertValues.createdAt.getTime()).toBe(4 * 3_600_000);
      expect(insertValues.slaDueAt.getTime() - insertValues.createdAt.getTime()).toBe(24 * 3_600_000);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "helpdesk.ticket.created", entityId: "42" }),
        mockTx,
      );
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("an org routing override wins over the default queue and carries its named assignee", async () => {
      mockConfig.routingRuleFor.mockResolvedValueOnce({ queue: "ADMIN", assigneeUserId: "agent1" });

      await service.create("org1", "user1", { title: "Laptop will not boot", category: "equipment" });

      expect(mockConfig.slaFor).toHaveBeenCalledWith("org1", "ADMIN");
      expect(mockTx.values.mock.calls[0]?.[0]).toMatchObject({ queue: "ADMIN", assigneeId: "agent1", assigneeMembershipId: 7 });
    });

    it("a request routed to the HR queue is confidential unless the requester says otherwise", async () => {
      await service.create("org1", "user1", { title: "Question about my leave balance", category: "leave_issue" });

      expect(mockTx.values.mock.calls[0]?.[0]).toMatchObject({ queue: "HR", isConfidential: true });
    });

    it("the created event names the queue so the consumer can notify its members", async () => {
      await service.create("org1", "user1", { title: "Reimbursement is late", category: "expense_reimbursement" });

      const outboxRow = mockTx.values.mock.calls[1]?.[0];
      expect(outboxRow).toMatchObject({
        eventType: "hr.helpdesk.ticket_created",
        payload: expect.objectContaining({ queue: "FINANCE", isConfidential: false }),
      });
    });

    it("does not swallow transaction errors", async () => {
      mockDb.transaction.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.create("org1", "user1", { title: "Help needed for payroll", category: "payroll_issue" }),
      ).rejects.toThrow("DB error");
    });
  });

  it("throws ConflictException on duplicate title during create", async () => {
    mockDb.limit.mockResolvedValue([{ id: 5 }]);

    await expect(
      service.create("org1", "user1", { title: "Help needed for payroll", category: "payroll_issue" }),
    ).rejects.toThrow(ConflictException);
  });

  describe("updateTicket — queue membership", () => {
    it("refuses an agent outside the ticket's queue with 403, since the ticket is visible to them", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "FINANCE", isConfidential: false }));

      await expect(
        service.updateTicket(actor({ queues: new Set(["IT"]) }), 1, { status: "IN_PROGRESS" }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("hides a confidential ticket outside the agent's queues behind 404", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "LEGAL", isConfidential: true }));

      await expect(
        service.updateTicket(actor({ queues: new Set(["IT"]) }), 1, { status: "IN_PROGRESS" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("a queue member moving the request out of TODO stamps the first response and audits the change", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "IT", firstRespondedAt: null }));
      mockTx.returning.mockResolvedValue([{ id: 1, title: "Need help", userId: "user1" }]);
      mockDb.limit.mockResolvedValueOnce([makeTicket({ id: 1 })]);

      await service.updateTicket(actor({ queues: new Set(["IT"]) }), 1, { status: "IN_PROGRESS" });

      expect(mockTx.set.mock.calls[0]?.[0]).toMatchObject({ status: "IN_PROGRESS", firstRespondedAt: expect.any(Date) });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "helpdesk.ticket.updated", entityId: "1" }),
        mockTx,
      );
    });

    it("emits ticket_assigned when assignee changes", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "IT", assigneeId: null }));
      mockTx.returning.mockResolvedValue([{ id: 1, title: "Need help", userId: "user1" }]);
      mockDb.limit.mockResolvedValueOnce([makeTicket({ id: 1 })]);

      await service.updateTicket(actor({ isAdmin: true }), 1, { assigneeId: "agent1" });

      expect(mockTx.values.mock.calls.map((call) => call[0]?.eventType)).toContain("hr.helpdesk.ticket_assigned");
    });

    it("throws NotFoundException when ticket not found", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(null);

      await expect(service.updateTicket(actor({ isAdmin: true }), 999, { status: "DONE" })).rejects.toThrow(NotFoundException);
    });
  });

  describe("suggest — canonical Document scope", () => {
    beforeEach(() => {
      mockAuth.resolveStanding.mockResolvedValue(mockStanding);
    });

    it("applies the restriction arm so an employee cannot see a Document restricted away from them", async () => {
      mockDb.execute.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.limit.mockResolvedValueOnce([]);

      await service.suggest(testUser, { query: "vacation" });

      const built = lastWhereSql();
      expect(built.sql).toContain("kb_page_restrictions");
    });

    it("results contain only slugged articles matched by the FTS probe", async () => {
      mockDb.execute.mockResolvedValueOnce([{ id: 5 }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: 5, title: "Leave Policy", slug: "leave-policy", excerpt: "About leave", source: "article" },
      ]);

      const result = await service.suggest(testUser, { query: "leave" });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ id: 5, slug: "leave-policy", source: "article" });
    });

    it("returns no results when the FTS probe finds nothing", async () => {
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await service.suggest(testUser, { query: "xyz" });

      expect(result.results).toHaveLength(0);
    });

    it("falls back to ILIKE when the FTS probe overflows the cap", async () => {
      mockDb.execute.mockResolvedValueOnce(Array.from({ length: 22 }, (_, i) => ({ id: i + 1 })));
      mockDb.limit.mockResolvedValueOnce([]);

      await service.suggest(testUser, { query: "policy" });

      const built = lastWhereSql();
      expect(built.sql).toMatch(/ilike/i);
    });
  });

  describe("comments — first response", () => {
    it("an agent's first comment stamps first_responded_at; the requester's does not", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "IT", firstRespondedAt: null }));
      mockTx.returning.mockResolvedValue([{ id: 9 }]);
      mockDb.limit.mockResolvedValueOnce([{ id: 9, ticketId: 1, orgId: "org1", authorId: "agent1", body: "On it" }]);

      await service.addComment(actor({ queues: new Set(["IT"]) }), 1, { body: "On it" });
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.set.mock.calls[0]?.[0]).toMatchObject({ firstRespondedAt: expect.any(Date) });

      jest.clearAllMocks();
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "IT", firstRespondedAt: null }));
      mockTx.returning.mockResolvedValue([{ id: 10 }]);
      mockDb.limit.mockResolvedValueOnce([{ id: 10 }]);
      mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));

      await service.addMyComment("org1", "user1", 11, 1, { body: "Any update?" });
      expect(mockTx.update).not.toHaveBeenCalled();
    });

    it("a non-member who can see a non-confidential ticket still may not respond to it", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ queue: "FINANCE", isConfidential: false }));

      await expect(service.addComment(actor({ queues: new Set(["IT"]) }), 1, { body: "Hi" })).rejects.toThrow(ForbiddenException);
    });

    it("the employee route answers 404 for a request they did not raise", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(makeTicket({ userId: "someone-else" }));

      await expect(service.addMyComment("org1", "user1", 11, 1, { body: "Hi" })).rejects.toThrow(NotFoundException);
    });
  });
});
