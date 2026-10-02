import { NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { projects, tickets, timesheets } from "../../../db/schema";
import { projectAccessRow, standingAccess } from "../__tests__/project-access-doubles";
import { TimesheetsService } from "./timesheets.service";
import type { LogTimeInput } from "./dto/timesheets.schemas";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP_ID = 7;
const PROJECT_A = 11;
const PROJECT_B = 22;
const ABSENT_PROJECT = 9999;
const TICKET_A = 901;
const TICKET_B = 902;
const PERIOD_ID = 77;

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

interface Store {
  projects: Row[];
  tickets: Row[];
  entries: Row[];
}

function makeStore(): Store {
  return {
    projects: [
      { id: PROJECT_A, orgId: ORG, managerMembershipId: 999, deletedAt: null },
      { id: PROJECT_B, orgId: ORG, managerMembershipId: 999, deletedAt: null },
    ],
    tickets: [
      { id: TICKET_A, orgId: ORG, projectId: PROJECT_A, timeSpent: "0", deletedAt: null },
      { id: TICKET_B, orgId: ORG, projectId: PROJECT_B, timeSpent: "0", deletedAt: null },
    ],
    entries: [],
  };
}

function makeU(orgId: string = ORG): CurrentUserContext {
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

function makeService(store: Store) {
  const transaction = jest.fn();

  const findTicket = jest.fn(async (args: { where?: unknown }) => {
    const ticket = store.tickets.find((row) => matches(args.where, row));
    if (!ticket) return undefined;
    return { projectId: ticket.projectId };
  });

  const findProject = jest.fn(async (args: { where?: unknown }) =>
    store.projects.find((row) => matches(args.where, row)) ?? undefined,
  );

  const insertBuilder = (table: unknown) => ({
    values: (values: Row) => ({
      returning: async () => {
        if (table === timesheets) store.entries.push({ ...values });
        return [{ ...values }];
      },
    }),
  });

  const updateBuilder = (table: unknown) => ({
    set: (values: Row) => ({
      where: async (where: unknown) => {
        if (table !== tickets) return;
        for (const row of store.tickets.filter((candidate) => matches(where, candidate)))
          Object.assign(row, values);
      },
    }),
  });

  transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ insert: insertBuilder, update: updateBuilder }),
  );

  const db = {
    query: { tickets: { findFirst: findTicket }, projects: { findFirst: findProject } },
    select: jest.fn(() => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          const rows =
            table === timesheets
              ? [
                  {
                    total: store.entries
                      .filter((row) => matches(where, row))
                      .reduce((sum, row) => sum + Number(row.hours), 0),
                  },
                ]
              : table === projects
                ? store.projects
                    .filter((row) => matches(where, row))
                    .map((row) => ({ ...projectAccessRow(), id: row.id }))
                : [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    })),
    update: updateBuilder,
    insert: insertBuilder,
    transaction,
  } as unknown as Db;

  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
  const access = standingAccess({ "build:manage": "all" }) as unknown as AccessService;
  const periodService = {
    loadSettings: jest.fn().mockResolvedValue({ workWeekStart: 1 }),
    getOrCreatePeriod: jest.fn().mockResolvedValue(PERIOD_ID),
  } as unknown as EntriesPeriodService;

  return {
    svc: new TimesheetsService(db, cache, access, periodService),
    transaction,
    findTicket,
  };
}

const LOG: LogTimeInput = { date: "2026-01-15", hours: 2 };

describe("TimesheetsService — logTicketTime binds the ticket to the URL project", () => {
  it("refuses a same-org ticket owned by another project and writes no entry", async () => {
    const store = makeStore();
    const { svc, transaction } = makeService(store);

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_B, LOG)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.entries).toHaveLength(0);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("logs time against the ticket that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc, transaction } = makeService(store);

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG)).resolves.toMatchObject({
      orgId: ORG,
      projectId: PROJECT_A,
      ticketId: TICKET_A,
      hours: "2",
      timesheetPeriodId: PERIOD_ID,
    });
    expect(store.entries).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a project id that holds no such ticket rather than 201 against the ticket's own project", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.logTicketTime(makeU(), ABSENT_PROJECT, TICKET_A, LOG)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.entries).toHaveLength(0);
  });

  it("refuses a ticket in the caller's project from another organisation", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.logTicketTime(makeU(OTHER_ORG), PROJECT_A, TICKET_A, LOG)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.entries).toHaveLength(0);
  });

  it("refuses a soft-deleted ticket in the URL project (control for the deletedAt predicate)", async () => {
    const store = makeStore();
    const target = store.tickets.find((row) => row.id === TICKET_A);
    if (target) target.deletedAt = new Date(0);
    const { svc } = makeService(store);

    await expect(svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.entries).toHaveLength(0);
  });

  it("recomputes timeSpent on the URL project's ticket only (control)", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await svc.logTicketTime(makeU(), PROJECT_A, TICKET_A, LOG);
    expect(store.tickets.find((row) => row.id === TICKET_A)?.timeSpent).toBe("2");
    expect(store.tickets.find((row) => row.id === TICKET_B)?.timeSpent).toBe("0");
  });
});
