import { Test, type TestingModule } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { BuildEntityActions } from "./build-entity.actions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { BuildTicketCreationService, resolveValidTicketStatuses } from "../core/tickets";
import type { EntityActor, EntityReference } from "../../entity-reference/entity-reference.types";

jest.mock("../core/tickets");

const mockResolveStatuses = jest.mocked(resolveValidTicketStatuses);

const ACTOR: EntityActor = { orgId: "org_1", userId: "user_1", isOrgOwner: false };
const OWNER: EntityActor = { orgId: "org_1", userId: "owner_1", isOrgOwner: true };
const TICKET_REF: EntityReference = { type: "ticket", id: "42" };
const PROJECT_REF: EntityReference = { type: "project", id: "7" };

const STUB_TICKET = {
  id: 42,
  status: "TODO",
  assigneeId: null as string | null,
  dueDate: null as string | null,
  projectId: 7,
};
const STUB_PROJECT = { key: "PROJ" };
const STUB_CREATED_TICKET = { id: 99, ticketNumber: 1, title: "New task", status: "TODO" };

function makeTx() {
  const tx: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    insert: jest.Mock;
    values: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
    select: jest.Mock;
    from: jest.Mock;
  } = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn().mockResolvedValue([{ max: 0 }]),
    insert: jest.fn(),
    values: jest.fn(),
    returning: jest.fn().mockResolvedValue([STUB_CREATED_TICKET]),
    execute: jest.fn(async (statement: SQL) => new PgDialect().sqlToQuery(statement).sql.includes("project_ticket_counters") ? [{ start: 1 }] : []),
    select: jest.fn(),
    from: jest.fn(),
  };
  tx.update.mockReturnValue(tx);
  tx.set.mockReturnValue(tx);
  tx.insert.mockReturnValue(tx);
  tx.values.mockReturnValue(tx);
  tx.select.mockReturnValue(tx);
  tx.from.mockReturnValue(tx);
  return tx;
}

const mockAudit = { log: jest.fn() };

const REACH = sql`true`;
const mockWriteDecision = jest.fn();

let mockTx: ReturnType<typeof makeTx>;

const mockDb = {
  query: {
    tickets: { findFirst: jest.fn() },
    projectMembers: { findFirst: jest.fn() },
    projects: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  transaction: jest.fn(),
  select: jest.fn(() => ({ from: () => ({ where: () => ({ limit: mockWriteDecision }) }) })),
};

describe("BuildEntityActions", () => {
  let service: BuildEntityActions;
  let mockTicketCreation: { createInTransaction: jest.Mock; publish: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 99 });
    mockWriteDecision.mockResolvedValue([{ state: "ACTIVE", reachable: true }]);
    mockTx = makeTx();
    mockDb.transaction.mockImplementation(
      async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => cb(mockTx),
    );
    mockTicketCreation = {
      createInTransaction: jest.fn().mockResolvedValue({ tickets: [STUB_CREATED_TICKET], command: {} }),
      publish: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildEntityActions,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } },
        { provide: BuildTicketCreationService, useValue: mockTicketCreation },
      ],
    }).compile();

    service = module.get(BuildEntityActions);
  });

  describe("access", () => {
    it("returns not-found for a non-integer id", async () => {
      const result = await service.run(ACTOR, { type: "ticket", id: "abc" }, "status", {}, REACH);
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found for id zero", async () => {
      const result = await service.run(ACTOR, { type: "ticket", id: "0" }, "status", {}, REACH);
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found when the ticket does not exist", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(null);
      const result = await service.run(ACTOR, TICKET_REF, "status", {}, REACH);
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found when the ticket is soft-deleted or belongs to another org", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(null);
      const result = await service.run(
        { ...ACTOR, orgId: "org_other" },
        TICKET_REF,
        "status",
        {}, REACH
      );
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found when the ticket has no associated project", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue({
        id: 42,
        status: "TODO",
        assigneeId: null,
        dueDate: null,
        projectId: null,
      });
      const result = await service.run(ACTOR, TICKET_REF, "status", {}, REACH);
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns forbidden when the actor is not a project member", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockWriteDecision.mockResolvedValue([{ state: "ACTIVE", reachable: false }]);

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_PROGRESS" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("returns forbidden when the ticket's project is archived, even for a project member", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockWriteDecision.mockResolvedValue([{ state: "ARCHIVED", reachable: true }]);

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_PROGRESS" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("decides an org owner's action through the same project write decision rather than a separate owner shortcut", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));

      const result = await service.run(OWNER, TICKET_REF, "status", { status: "IN_PROGRESS" }, REACH);

      expect(result).toMatchObject({ ok: true });
      expect(mockWriteDecision).toHaveBeenCalledTimes(1);
      expect(mockDb.query.projects.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("routing", () => {
    it("returns invalid for an unknown actionId on a ticket", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "delete", {}, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid for a non-ticket, non-project-create reference type", async () => {
      const result = await service.run(ACTOR, { type: "sprint", id: "1" }, "status", {}, REACH);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("routes project + create-ticket to ticket creation without touching the ticket table", async () => {
      mockWriteDecision.mockResolvedValue([{ state: "ACTIVE", reachable: false }]);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(mockDb.query.tickets.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("changeStatus", () => {
    it("returns ok with null message when the status is unchanged", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "TODO" }, REACH);

      expect(result).toEqual({
        ok: true,
        message: null,
        data: { prevStatus: "TODO", nextStatus: "TODO" },
      });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("returns invalid when the target status is not in the project's valid set", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "DONE"]));

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_REVIEW" }, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when the status input is absent", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "status", {}, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });


    /**
     * The action's declared option source offers the ticket's project members.
     * These pin that submission accepts exactly that set - offering a candidate
     * the adapter would refuse is the same defect as discovery offering an
     * action submission refuses, which is already pinned on the adapter.
     */
    it("accepts an assignee who is a member of the ticket's project", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValueOnce({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", {
        assigneeId: "user_2",
      }, REACH);

      expect(result.ok).toBe(true);
    });

    it("refuses an assignee the option source would never have offered", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValueOnce(null);

      const result = await service.run(ACTOR, TICKET_REF, "assign", {
        assigneeId: "someone-outside-the-project",
      }, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_PROGRESS" }, REACH);

      expect(result).toMatchObject({
        ok: true,
        message: "Status changed from TODO to IN_PROGRESS",
        data: { prevStatus: "TODO", nextStatus: "IN_PROGRESS" },
      });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("assign", () => {
    it("returns invalid when assigneeId is absent from input", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", {}, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when assigneeId is an empty string", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", { assigneeId: "" }, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", { assigneeId: "user_2" }, REACH);

      expect(result).toEqual({ ok: true, message: "Assignee updated", data: {} });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("setDueDate", () => {
    it("returns invalid when dueDate is absent from input", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", {}, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when dueDate is an empty string", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", { dueDate: "" }, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", { dueDate: "2026-12-31" }, REACH);

      expect(result).toEqual({ ok: true, message: "Due date set to 2026-12-31", data: {} });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("createTicket (project + create-ticket)", () => {
    it("returns forbidden when the actor is not a project member", async () => {
      mockWriteDecision.mockResolvedValue([{ state: "ACTIVE", reachable: false }]);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("returns invalid when the ticket type is not in the allowed set", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "EPIC" }, REACH);

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns not-found when the project is absent from the org or soft-deleted", async () => {
      mockWriteDecision.mockResolvedValue([]);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" }, REACH);

      expect(result).toEqual({ ok: false, reason: "not-found" });
      expect(mockTicketCreation.createInTransaction).not.toHaveBeenCalled();
    });

    it("returns forbidden when the project is completed", async () => {
      mockWriteDecision.mockResolvedValue([{ state: "COMPLETED", reachable: true }]);
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(mockTicketCreation.createInTransaction).not.toHaveBeenCalled();
    });

    it("returns forbidden when the project key lookup finds no live project", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(null);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" }, REACH);

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("creates a ticket inside a transaction and returns the ticket data", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "TASK",
        title: "Do something",
      }, REACH);

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.data).toMatchObject({
          ticketId: 99,
          ticketNumber: 1,
          projectKey: "PROJ",
          title: "New task",
          status: "TODO",
        });
      }
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTicketCreation.createInTransaction).toHaveBeenCalledTimes(1);
    });

    it("links the ticket back to the chat message it was converted from", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "TASK",
        description: "from chat",
        sourceChannelId: 3,
        sourceMessageId: 9,
      }, REACH);

      expect(result).toMatchObject({ ok: true });
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
      expect(mockTicketCreation.createInTransaction).toHaveBeenCalledTimes(1);
      expect(mockTicketCreation.createInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          drafts: expect.arrayContaining([
            expect.objectContaining({ activityToValue: "From a chat message" }),
          ]),
        }),
      );
      expect(mockTx.values).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 99,
          url: expect.stringMatching(/\/chat\?channel=3&message=9$/),
          label: "Chat message",
        }),
      );
    });

    it("writes no backlink when the source ids are not positive integers", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);

      await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "TASK",
        sourceChannelId: "https://evil.example",
        sourceMessageId: 9,
      }, REACH);

      expect(mockTx.insert).not.toHaveBeenCalled();
      expect(mockTicketCreation.createInTransaction).toHaveBeenCalledTimes(1);
    });

    it("uses description as title fallback when title is absent", async () => {
      mockDb.query.projects.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);
      mockTx.returning.mockResolvedValue([{ ...STUB_CREATED_TICKET, title: "Fix login bug" }]);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "BUG",
        description: "Fix login bug",
      }, REACH);

      expect(result).toMatchObject({ ok: true });
    });
  });
});
