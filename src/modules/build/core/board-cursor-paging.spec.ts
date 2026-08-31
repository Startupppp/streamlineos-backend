import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { TICKETS_PERMISSION } from "./tickets-scope";

// The board is an infinite scroll over a table the whole team writes to; by page number a ticket created mid-scroll duplicates one row and hides another.

const dialect = new PgDialect();
const ORG = "org-1";
const PROJECT = 1;

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

interface StoredTicket {
  id: number;
  rank: string;
}

class Board {
  readonly rows: StoredTicket[] = [];
  private next = 1;

  constructor(count: number) {
    for (let i = 0; i < count; i++) this.insert();
  }

  /** Inserts at the top of the board, which is what shifts an offset page. */
  insert(): StoredTicket {
    const id = this.next++;
    const row = { id, rank: String(100000 - id).padStart(8, "0") };
    this.rows.push(row);
    return row;
  }

  private sorted(): StoredTicket[] {
    return [...this.rows].sort((a, b) => (a.rank === b.rank ? a.id - b.id : a.rank < b.rank ? -1 : 1));
  }

  after(position: { rank: string; id: number } | undefined, limit: number): StoredTicket[] {
    return this.sorted()
      .filter((r) => !position || r.rank > position.rank || (r.rank === position.rank && r.id > position.id))
      .slice(0, limit);
  }

  byOffset(page: number, limit: number): StoredTicket[] {
    return this.sorted().slice((page - 1) * limit, page * limit);
  }
}

/** Reads the keyset bound back out of the predicate the service compiled. */
function positionFromPredicate(where: SQL): { rank: string; id: number } | undefined {
  const { sql: text, params } = dialect.sqlToQuery(where);
  if (!/"rank"\s*,\s*(?:"build"\.)?"tickets"\."id"\)\s*>\s*\(/i.test(text)) return undefined;
  const rank = params[params.length - 2];
  const id = params[params.length - 1];
  if (typeof rank !== "string" || typeof id !== "number")
    throw new Error(`keyset bound was (${typeof rank}, ${typeof id}): ${text}`);
  return { rank, id };
}

function buildHarness(board: Board) {
  let afterRead: (() => void) | undefined;

  const chain = (): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    let position: { rank: string; id: number } | undefined;
    link["from"] = jest.fn(() => link);
    link["where"] = jest.fn((w: SQL) => {
      position = positionFromPredicate(w);
      return link;
    });
    link["orderBy"] = jest.fn(() => link);
    link["limit"] = jest.fn((n: number) => {
      const rows = board.after(position, n).map((r) => ({ ...r, total: String(board.rows.length) }));
      if (afterRead) afterRead();
      return Promise.resolve(rows);
    });
    return link;
  };

  const db = {
    select: jest.fn(() => chain()),
    query: {
      projects: { findFirst: jest.fn(() => Promise.resolve({ id: PROJECT, managerId: null })) },
      tickets: {
        findMany: jest.fn(({ where }: { where: SQL }) => {
          const { params } = dialect.sqlToQuery(where);
          const ids = params.filter((p): p is number => typeof p === "number");
          return Promise.resolve(ids.map((id) => ({ id, title: `T${id}` })));
        }),
      },
    },
  } as unknown as Db;

  const access = {
    resolveUserPermissions: jest.fn(() =>
      Promise.resolve(new Map<string, DataScope>([["build:manage", "all"], [TICKETS_PERMISSION, "all"]])),
    ),
    scopeFor: jest.fn(() => Promise.resolve("all" as DataScope)),
    holds: jest.fn(() => Promise.resolve(true)),
  } as unknown as AccessService;

  const service = new ProjectsTicketsReadService(db, access);
  return { service, onRead: (fn: () => void) => { afterRead = fn; } };
}

const cursorQuery = (limit: number, cursor?: string) =>
  ({ page: 1, limit, paging: "cursor", cursor, orderBy: "rank", orderDir: "asc", scope: "all" }) as never;

async function pageThrough(harness: ReturnType<typeof buildHarness>, limit: number) {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = (await harness.service.listTickets(USER, PROJECT, cursorQuery(limit, cursor))) as {
      data: { id: number }[];
      nextCursor: string | null;
    };
    ids.push(...page.data.map((t) => t.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

function duplicates(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort((a, b) => a - b);
}

describe("board paging by cursor — every ticket exactly once", () => {
  it("walks a board whose size is not a multiple of the page", async () => {
    const board = new Board(23);
    const ids = await pageThrough(buildHarness(board), 10);

    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(board.rows.map((r) => r.id));
  });

  it("shows every original ticket exactly once while tickets arrive above the reader", async () => {
    const board = new Board(30);
    const original = board.rows.map((r) => r.id);
    const harness = buildHarness(board);
    harness.onRead(() => {
      board.insert();
      board.insert();
    });

    const ids = await pageThrough(harness, 10);

    expect(duplicates(ids)).toEqual([]);
    for (const id of original) expect(ids).toContain(id);
  });

  it("returns the sentinel ticket on the next page rather than skipping it", async () => {
    const limit = 10;
    const harness = buildHarness(new Board(limit + 1));

    const first = (await harness.service.listTickets(USER, PROJECT, cursorQuery(limit))) as {
      data: { id: number }[];
      nextCursor: string | null;
    };
    expect(first.data).toHaveLength(limit);

    const second = (await harness.service.listTickets(
      USER,
      PROJECT,
      cursorQuery(limit, first.nextCursor ?? undefined),
    )) as { data: { id: number }[]; nextCursor: string | null };

    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(duplicates([...first.data, ...second.data].map((t) => t.id))).toEqual([]);
  });

  it("carries the total on the first page only, so a deep page pays for no count", async () => {
    const harness = buildHarness(new Board(25));

    const first = (await harness.service.listTickets(USER, PROJECT, cursorQuery(10))) as {
      total?: number;
      nextCursor: string | null;
    };
    expect(first.total).toBe(25);

    const second = (await harness.service.listTickets(
      USER,
      PROJECT,
      cursorQuery(10, first.nextCursor ?? undefined),
    )) as { total?: number };
    expect(second.total).toBeUndefined();
  });

  it("treats a malformed cursor as the first page rather than an error", async () => {
    const board = new Board(5);
    const harness = buildHarness(board);

    const page = (await harness.service.listTickets(USER, PROJECT, cursorQuery(10, "not-a-cursor"))) as {
      data: { id: number }[];
    };

    expect(page.data.map((t) => t.id).sort((a, b) => a - b)).toEqual(board.rows.map((r) => r.id));
  });
});

describe("board paging — what page numbers do on the same data", () => {
  it("repeats tickets the cursor does not, once tickets arrive above the reader", () => {
    const board = new Board(30);
    const original = board.rows.map((r) => r.id);
    const seen: number[] = [];

    for (let page = 1; page <= 3; page++) {
      seen.push(...board.byOffset(page, 10).map((r) => r.id));
      board.insert();
      board.insert();
    }

    expect(duplicates(seen).length).toBeGreaterThan(0);
    expect(original.filter((id) => !seen.includes(id)).length).toBeGreaterThan(0);
  });
});
