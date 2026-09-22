import { Test, type TestingModule } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { BuildEntityActions } from "./build-entity.actions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { resolveValidTicketStatuses } from "../core/ticket-status.util";
import type { EntityActor, EntityReference } from "../../entity-reference/entity-reference.types";

jest.mock("../core/ticket-status.util");

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

let mockTx: ReturnType<typeof makeTx>;

const mockDb = {
  query: {
    tickets: { findFirst: jest.fn() },
    projectMembers: { findFirst: jest.fn() },
    projects: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  transaction: jest.fn(),
};

describe("BuildEntityActions", () => {
  let service: BuildEntityActions;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 99 });
    mockTx = makeTx();
    mockDb.transaction.mockImplementation(
      async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => cb(mockTx),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildEntityActions,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(BuildEntityActions);
  });

  describe("access", () => {
    it("returns not-found for a non-integer id", async () => {
      const result = await service.run(ACTOR, { type: "ticket", id: "abc" }, "status", {});
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found for id zero", async () => {
      const result = await service.run(ACTOR, { type: "ticket", id: "0" }, "status", {});
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found when the ticket does not exist", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(null);
      const result = await service.run(ACTOR, TICKET_REF, "status", {});
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-found when the ticket is soft-deleted or belongs to another org", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(null);
      const result = await service.run(
        { ...ACTOR, orgId: "org_other" },
        TICKET_REF,
        "status",
        {},
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
      const result = await service.run(ACTOR, TICKET_REF, "status", {});
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns forbidden when the actor is not a project member", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue(null);

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_PROGRESS" });

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("does not query project membership for an org owner", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));

      const result = await service.run(OWNER, TICKET_REF, "status", { status: "IN_PROGRESS" });

      expect(result).toMatchObject({ ok: true });
      expect(mockDb.query.projectMembers.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("routing", () => {
    it("returns invalid for an unknown actionId on a ticket", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "delete", {});

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid for a non-ticket, non-project-create reference type", async () => {
      const result = await service.run(ACTOR, { type: "sprint", id: "1" }, "status", {});
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("routes project + create-ticket to ticket creation without touching the ticket table", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue(null);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" });

      expect(result).toEqual({ ok: false, reason: "forbidden" });
      expect(mockDb.query.tickets.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("changeStatus", () => {
    it("returns ok with null message when the status is unchanged", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "TODO" });

      expect(result).toEqual({
        ok: true,
        message: null,
        data: { prevStatus: "TODO", nextStatus: "TODO" },
      });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("returns invalid when the target status is not in the project's valid set", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "DONE"]));

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_REVIEW" });

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when the status input is absent", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "status", {});

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
      mockDb.query.projectMembers.findFirst
        .mockResolvedValueOnce({ projectId: 7 })
        .mockResolvedValueOnce({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", {
        assigneeId: "user_2",
      });

      expect(result.ok).toBe(true);
    });

    it("refuses an assignee the option source would never have offered", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst
        .mockResolvedValueOnce({ projectId: 7 })
        .mockResolvedValueOnce(null);

      const result = await service.run(ACTOR, TICKET_REF, "assign", {
        assigneeId: "someone-outside-the-project",
      });

      expect(result).toEqual({ ok: false, reason: "invalid" });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });
      mockResolveStatuses.mockResolvedValue(new Set(["TODO", "IN_PROGRESS"]));

      const result = await service.run(ACTOR, TICKET_REF, "status", { status: "IN_PROGRESS" });

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
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", {});

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when assigneeId is an empty string", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", { assigneeId: "" });

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "assign", { assigneeId: "user_2" });

      expect(result).toEqual({ ok: true, message: "Assignee updated", data: {} });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("setDueDate", () => {
    it("returns invalid when dueDate is absent from input", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", {});

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns invalid when dueDate is an empty string", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", { dueDate: "" });

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("executes the ticket update and activity-log insert inside the same transaction", async () => {
      mockDb.query.tickets.findFirst.mockResolvedValue(STUB_TICKET);
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, TICKET_REF, "due-date", { dueDate: "2026-12-31" });

      expect(result).toEqual({ ok: true, message: "Due date set to 2026-12-31", data: {} });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.update).toHaveBeenCalledTimes(1);
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("createTicket (project + create-ticket)", () => {
    it("returns forbidden when the actor is not a project member", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue(null);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" });

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("returns invalid when the ticket type is not in the allowed set", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "EPIC" });

      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns forbidden when the project does not exist in the org", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(null);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", { type: "TASK" });

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    it("creates a ticket inside a transaction and returns the ticket data", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "TASK",
        title: "Do something",
      });

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
      expect(mockTx.insert).toHaveBeenCalledTimes(1);
    });

    it("uses description as title fallback when title is absent", async () => {
      mockDb.query.projectMembers.findFirst.mockResolvedValue({ projectId: 7 });
      mockDb.query.projects.findFirst.mockResolvedValue(STUB_PROJECT);
      mockTx.returning.mockResolvedValue([{ ...STUB_CREATED_TICKET, title: "Fix login bug" }]);

      const result = await service.run(ACTOR, PROJECT_REF, "create-ticket", {
        type: "BUG",
        description: "Fix login bug",
      });

      expect(result).toMatchObject({ ok: true });
    });
  });
});
