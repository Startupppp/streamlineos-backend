import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { ScopedRead } from "../../access/scoped-read";
import { SupportDraftsService } from "./support-drafts.service";
import { SupportIntegrationsService } from "./support-integrations.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";
import { SupportTicketsService } from "./support-tickets.service";

const dialect = new PgDialect();
const ORG = "org-support";
const ME = "user-agent";
const TICKET_ID = 41;

function renderWhere(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL)) throw new Error("expected a SQL WHERE clause");
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

interface Harness {
  findFirst: jest.Mock;
  transaction: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  db: Db;
}

function makeHarness(): Harness {
  const findFirst = jest.fn().mockResolvedValue({ id: TICKET_ID, status: "OPEN", mergedIntoTicketId: null });
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn),
    finally: (fn: () => void) => Promise.resolve([]).finally(fn),
  };
  for (const m of ["set", "where", "values", "onConflictDoNothing", "onConflictDoUpdate", "returning", "from", "leftJoin", "orderBy", "limit", "groupBy"])
    chain[m] = jest.fn(() => chain);
  const insert = jest.fn(() => chain);
  const update = jest.fn(() => chain);
  const transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(chain));
  const db = {
    query: {
      supportTickets: { findFirst, findMany: jest.fn().mockResolvedValue([]) },
      supportTicketMessages: { findMany: jest.fn().mockResolvedValue([]) },
      supportTicketLinks: { findMany: jest.fn().mockResolvedValue([]) },
      supportTicketExternalLinks: { findMany: jest.fn().mockResolvedValue([]) },
      supportTicketDrafts: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn(() => chain),
    insert,
    update,
    delete: jest.fn(() => chain),
    transaction,
  } as unknown as Db;
  return { findFirst, transaction, insert, update, db };
}

const noop = {} as never;

type Invoke = (h: Harness, read: ScopedRead) => Promise<unknown>;

function operations(h: Harness): SupportTicketOperationsService {
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), invalidate: jest.fn().mockResolvedValue(undefined) };
  const activity = { recordActivity: jest.fn().mockResolvedValue(undefined) };
  return new SupportTicketOperationsService(h.db, cache as never, activity as never);
}

function tickets(h: Harness): SupportTicketsService {
  const cache = {
    cached: jest.fn(),
    cachedVersioned: jest.fn(),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const activity = {
    recordActivity: jest.fn().mockResolvedValue(undefined),
    listActivity: jest.fn().mockResolvedValue([]),
    stats: jest.fn().mockResolvedValue({}),
  };
  const messages = {
    listMessages: jest.fn().mockResolvedValue([]),
    addMessage: jest.fn().mockResolvedValue({ id: 1, ticketId: TICKET_ID, body: "a reply" }),
  };
  return new SupportTicketsService(
    h.db, cache as never, noop, noop, noop, noop, noop, noop, noop, noop,
    activity as never, messages as never, operations(h) as never,
  );
}

const CASES: ReadonlyArray<{ name: string; run: Invoke }> = [
  {
    name: "SupportTicketMessagesService.listMessages",
    run: (h, read) => {
      const svc = new SupportTicketMessagesService(h.db, noop, noop, noop, noop, noop);
      return svc.listMessages(ORG, TICKET_ID, read);
    },
  },
  {
    name: "SupportTicketActivityService.listActivity",
    run: (h, read) => new SupportTicketActivityService(h.db).listActivity(ORG, TICKET_ID, read),
  },
  {
    name: "SupportTicketOperationsService.listTicketLinks",
    run: (h, read) => operations(h).listTicketLinks(ORG, TICKET_ID, read),
  },
  {
    name: "SupportTicketOperationsService.addTicketLink",
    run: (h, read) => operations(h).addTicketLink(ORG, TICKET_ID, ME, { linkedTicketId: 99, relation: "related" } as never, read),
  },
  {
    name: "SupportTicketOperationsService.mergeTicket",
    run: (h, read) => operations(h).mergeTicket(ORG, TICKET_ID, ME, { intoTicketId: 99 } as never, read),
  },
  {
    name: "SupportTicketOperationsService.snoozeTicket",
    run: (h, read) => operations(h).snoozeTicket(ORG, TICKET_ID, ME, { snoozedUntil: new Date("2030-01-01T00:00:00.000Z") } as never, read),
  },
  {
    name: "SupportTicketOperationsService.unsnoozeTicket",
    run: (h, read) => operations(h).unsnoozeTicket(ORG, TICKET_ID, ME, read),
  },
  {
    name: "SupportTicketsService.splitTicket",
    run: (h, read) => tickets(h).splitTicket(ORG, TICKET_ID, ME, { title: "A split ticket title" } as never, read, 7),
  },
  {
    name: "SupportDraftsService.getDraft",
    run: (h, read) => new SupportDraftsService(h.db).getDraft(ORG, TICKET_ID, ME, 7, read),
  },
  {
    name: "SupportIntegrationsService.listLinks",
    run: (h, read) => new SupportIntegrationsService(h.db).listLinks(ORG, TICKET_ID, read),
  },
  {
    name: "SupportIntegrationsService.addLink",
    run: (h, read) => new SupportIntegrationsService(h.db).addLink(ORG, TICKET_ID, ME, { entityType: "project", entityId: 3 } as never, read),
  },
  {
    name: "SupportIntegrationsService.removeLink",
    run: (h, read) => new SupportIntegrationsService(h.db).removeLink(ORG, TICKET_ID, 5, read),
  },
  {
    name: "SupportDraftsService.upsertDraft",
    run: (h, read) => new SupportDraftsService(h.db).upsertDraft(ORG, TICKET_ID, ME, 7, { body: "draft", isInternal: false } as never, read),
  },
  {
    name: "SupportDraftsService.deleteDraft",
    run: (h, read) => new SupportDraftsService(h.db).deleteDraft(ORG, TICKET_ID, ME, 7, read),
  },
  {
    name: "SupportTicketsService.replyAsAgent",
    run: (h, read) => tickets(h).replyAsAgent(ORG, TICKET_ID, ME, { body: "a reply", isInternal: false } as never, read),
  },
];

describe("support ticket child surfaces spend the DataScope on the parent ticket", () => {
  it("enumerates every method under test — an empty table cannot pass vacuously", () => {
    expect(CASES).toHaveLength(15);
  });

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — own scope narrows the parent read on the assignee membership and binds the caller",
    async (_name, run) => {
      const h = makeHarness();
      await run(h, ScopedRead.of(ORG, ME, "own")).catch(() => undefined);
      expect(h.findFirst).toHaveBeenCalled();
      const { sql, params } = renderWhere(h.findFirst.mock.calls[0]?.[0]?.where);
      expect(sql).toContain("assignee_membership_id");
      expect(sql).toContain("organization_members");
      expect(sql).toContain("org_id");
      expect(params).toContain(ME);
      expect(params).toContain(ORG);
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — all scope keeps the tenant predicate without binding the actor",
    async (_name, run) => {
      const h = makeHarness();
      await run(h, ScopedRead.of(ORG, ME, "all")).catch(() => undefined);
      expect(h.findFirst).toHaveBeenCalled();
      const { sql, params } = renderWhere(h.findFirst.mock.calls[0]?.[0]?.where);
      expect(sql).toContain("org_id");
      expect(params).toContain(ORG);
      expect(params).not.toContain(ME);
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — none scope issues no query at all and refuses",
    async (_name, run) => {
      const h = makeHarness();
      await expect(run(h, ScopedRead.of(ORG, ME, "none"))).rejects.toThrow(ForbiddenException);
      expect(h.findFirst).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — an id from another tenant is a 404, never a 403",
    async (_name, run) => {
      const h = makeHarness();
      h.findFirst.mockResolvedValue(undefined);
      await expect(run(h, ScopedRead.of(ORG, ME, "own"))).rejects.toThrow(NotFoundException);
    },
  );

  it.each(CASES.map((c) => [c.name, c.run] as const))(
    "%s — an in-tenant ticket the caller is not assigned is a 403, not an existence oracle",
    async (_name, run) => {
      const h = makeHarness();
      h.findFirst
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ id: TICKET_ID, status: "OPEN", mergedIntoTicketId: null });
      await expect(run(h, ScopedRead.of(ORG, ME, "own"))).rejects.toThrow(ForbiddenException);
    },
  );
});
