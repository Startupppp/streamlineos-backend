import { NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { ProjectsTicketNotFoundException } from "../../../common/http/api-exceptions";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP_ID = 7;
const PROJECT_A = 11;
const PROJECT_B = 22;
const TICKET_A = 900;
const TICKET_B = 901;

type Row = Record<string, unknown>;

interface Predicate {
  key: string;
  op: "eq" | "isNull";
  value?: unknown;
}

function columnKey(column: Column): string {
  const table = column.table as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(table)) {
    if (value === column) return key;
  }
  return column.name;
}

function chunkText(chunk: unknown): string {
  const value = (chunk as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? value.join("").trim() : "";
}

function collect(node: unknown, out: Predicate[]): Predicate[] {
  if (!(node instanceof SQL)) return out;
  const chunks = node.queryChunks as unknown[];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk instanceof SQL) {
      collect(chunk, out);
      continue;
    }
    if (!(chunk instanceof Column)) continue;
    const operator = chunkText(chunks[index + 1]);
    if (operator === "=") {
      const param = chunks[index + 2] as { value?: unknown };
      out.push({ key: columnKey(chunk), op: "eq", value: param?.value });
    } else if (operator === "is null") {
      out.push({ key: columnKey(chunk), op: "isNull" });
    }
  }
  return out;
}

function matches(where: unknown, row: Row): boolean {
  const predicates = collect(where, []);
  expect(predicates.length).toBeGreaterThan(0);
  return predicates.every((predicate) =>
    predicate.op === "isNull"
      ? row[predicate.key] === null || row[predicate.key] === undefined
      : row[predicate.key] === predicate.value,
  );
}

function makeTickets(): Row[] {
  return [
    {
      id: TICKET_A, orgId: ORG, projectId: PROJECT_A, title: "ticket-a", ticketNumber: 1,
      status: "OPEN", priority: "MEDIUM", version: 1, epicId: null, parentTicketId: null,
      reporterId: "user-7", assigneeMembershipId: null, sprintId: null, startDate: null,
      dueDate: null, points: null, type: "TASK", cycleId: null, updatedAt: new Date(0),
      deletedAt: null, assignee: null, assignees: [], watchers: [], comments: [],
      attachments: [], labels: [], project: { id: PROJECT_A, name: "A", key: "A", orgId: ORG },
      sprint: null,
    },
    {
      id: TICKET_B, orgId: ORG, projectId: PROJECT_B, title: "ticket-b", ticketNumber: 2,
      status: "OPEN", priority: "MEDIUM", version: 1, epicId: null, parentTicketId: null,
      reporterId: "user-7", assigneeMembershipId: null, sprintId: null, startDate: null,
      dueDate: null, points: null, type: "TASK", cycleId: null, updatedAt: new Date(0),
      deletedAt: null, assignee: null, assignees: [], watchers: [], comments: [],
      attachments: [], labels: [], project: { id: PROJECT_B, name: "B", key: "B", orgId: ORG },
      sprint: null,
    },
  ];
}

function makeU(orgId = ORG): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

describe("getTicket — the ticket detail read binds to the URL project", () => {
  function makeDetail(rows: Row[]) {
    const findFirst = jest.fn(async (args: { where?: unknown }) =>
      rows.find((row) => matches(args.where, row)),
    );
    const db = { query: { tickets: { findFirst } } } as unknown as Db;
    const svc = new ProjectsTicketsDetailService(
      db,
      { scopeFor: jest.fn().mockResolvedValue("all") } as never,
      { log: jest.fn() } as never,
    );
    return { svc, findFirst };
  }

  it("answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc } = makeDetail(makeTickets());

    await expect(svc.getTicket(makeU(), PROJECT_A, TICKET_B)).rejects.toBeInstanceOf(
      ProjectsTicketNotFoundException,
    );
  });

  it("reads the ticket that belongs to the URL project (control)", async () => {
    const { svc } = makeDetail(makeTickets());

    await expect(svc.getTicket(makeU(), PROJECT_A, TICKET_A)).resolves.toMatchObject({
      id: TICKET_A,
      projectId: PROJECT_A,
    });
  });

  it("answers 404 rather than 403 for a foreign-project id, so the response cannot confirm the row exists", async () => {
    const { svc } = makeDetail(makeTickets());

    await expect(svc.getTicket(makeU(), PROJECT_A, TICKET_B)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("still refuses another organisation's ticket (control for the tenant predicate)", async () => {
    const { svc } = makeDetail(makeTickets());

    await expect(svc.getTicket(makeU(OTHER_ORG), PROJECT_A, TICKET_A)).rejects.toBeInstanceOf(
      ProjectsTicketNotFoundException,
    );
  });
});

describe("updateTicket — the pre-read binds to the URL project when the route carries one", () => {
  function makeUpdate(rows: Row[]) {
    const findFirst = jest.fn(async (args: { where?: unknown }) =>
      rows.find((row) => matches(args.where, row)),
    );
    const transaction = jest.fn();
    const db = {
      query: { tickets: { findFirst } },
      select: jest.fn(() => ({
        from: () => ({ innerJoin: () => ({ where: async () => [] }) }),
      })),
      transaction,
    } as unknown as Db;
    const svc = new ProjectsTicketsService(
      db,
      {} as never,
      {} as never,
      {} as never,
      { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" }) } as never,
      {} as never,
      {} as never,
      {} as never,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      new ProjectsTicketsUpdateService(
        db,
        {} as never,
        { logTicketFieldChanges: jest.fn().mockResolvedValue(undefined) } as never,
        { authorizeMutation: jest.fn().mockResolvedValue(undefined) } as never,
        { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" }) } as never,
        { notifyNewAssignees: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { runForTicketEvent: jest.fn() } as never,
        { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never,
        { holds: jest.fn().mockResolvedValue(true) } as never,
      ),
    );
    return { svc, transaction };
  }

  it("answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc, transaction } = makeUpdate(makeTickets());

    await expect(svc.updateTicket(makeU(), PROJECT_A, TICKET_B, { title: "hijacked" })).rejects.toThrow(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reaches the transaction for the ticket that belongs to the URL project (control)", async () => {
    const rows = makeTickets();
    const { svc, transaction } = makeUpdate(rows);
    transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: TICKET_A }] }) }) }),
        delete: () => ({ where: async () => [] }),
        insert: () => ({ values: async () => [] }),
        execute: async () => [],
      }),
    );

    await expect(
      svc.updateTicket(makeU(), PROJECT_A, TICKET_A, { title: "renamed" }),
    ).resolves.toMatchObject({ updated: true });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("a project-less caller still cannot reach another organisation's ticket", async () => {
    const { svc, transaction } = makeUpdate(makeTickets());

    await expect(
      svc.updateTicket(makeU(OTHER_ORG), null, TICKET_A, { title: "hijacked" }),
    ).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a project-less caller still reaches its own organisation's ticket (control)", async () => {
    const { svc, transaction } = makeUpdate(makeTickets());
    transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: TICKET_B }] }) }) }),
        delete: () => ({ where: async () => [] }),
        insert: () => ({ values: async () => [] }),
        execute: async () => [],
      }),
    );

    await expect(
      svc.updateTicket(makeU(), null, TICKET_B, { title: "renamed" }),
    ).resolves.toMatchObject({ updated: true });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("deleteTicket — the delete pre-read binds to the URL project", () => {
  function makeDelete(rows: Row[]) {
    const findFirst = jest.fn(async (args: { where?: unknown }) =>
      rows.find((row) => matches(args.where, row)),
    );
    const transaction = jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        update: () => ({ set: () => ({ where: async () => [] }) }),
        delete: () => ({ where: async () => [] }),
      }),
    );
    const db = {
      query: {
        tickets: { findFirst },
        workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
      },
      transaction,
    } as unknown as Db;
    const svc = new ProjectsTicketsService(
      db,
      {} as never,
      {} as never,
      {} as never,
      { checkProjectAccess: jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" }) } as never,
      {} as never,
      {} as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
    );
    return { svc, transaction };
  }

  it("answers 404 for a same-org ticket that belongs to another project", async () => {
    const { svc, transaction } = makeDelete(makeTickets());

    await expect(svc.deleteTicket(ORG, "user-7", PROJECT_A, TICKET_B, false)).rejects.toThrow(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("deletes the ticket that belongs to the URL project (control)", async () => {
    const { svc, transaction } = makeDelete(makeTickets());

    await expect(svc.deleteTicket(ORG, "user-7", PROJECT_A, TICKET_A, false)).resolves.toEqual({
      deleted: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("still refuses another organisation's ticket (control for the tenant predicate)", async () => {
    const { svc, transaction } = makeDelete(makeTickets());

    await expect(svc.deleteTicket(OTHER_ORG, "user-7", PROJECT_A, TICKET_A, false)).rejects.toThrow(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("the delete transaction mock really runs its callback, so the assertions above are not vacuous", async () => {
    const { svc, transaction } = makeDelete(makeTickets());

    await svc.deleteTicket(ORG, "user-7", PROJECT_A, TICKET_A, false);
    const callback = transaction.mock.calls[0]?.[0] as unknown;
    expect(typeof callback).toBe("function");
    expect(transaction.mock.results[0]?.type).toBe("return");
  });
});
