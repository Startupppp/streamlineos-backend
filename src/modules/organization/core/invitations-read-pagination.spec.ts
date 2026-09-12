import { BadRequestException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";
import { InvitationsReadService } from "./invitations-read.service";
import type { Db } from "../../../db/drizzle.module";

interface InvitationFixtureRow {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  status: string;
  revokedAt: Date | null;
  declinedAt: Date | null;
  deliveryFailed: boolean;
}

interface DecodedPosition {
  sortValue: string;
  id: string;
}

const dialect = new PgDialect();

function renderWhere(where: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(where as SQL);
  return { sql: query.sql, params: query.params };
}

function row(id: string, createdAt: Date, overrides: Partial<InvitationFixtureRow> = {}): InvitationFixtureRow {
  return {
    id,
    email: `${id}@example.com`,
    role: "MEMBER",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    acceptedAt: null,
    createdAt,
    status: "PENDING",
    revokedAt: null,
    declinedAt: null,
    deliveryFailed: false,
    ...overrides,
  };
}

/**
 * The order the database is asked for: newest first, id descending as the
 * tie-breaker. Written out here rather than assumed, because the whole point of
 * the equal-timestamp fixtures is that createdAt alone is not a total order.
 */
function sortNewestFirst(rows: InvitationFixtureRow[]): InvitationFixtureRow[] {
  return [...rows].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

function strictlyBefore(candidate: InvitationFixtureRow, position: DecodedPosition): boolean {
  const anchor = new Date(position.sortValue).getTime();
  const at = candidate.createdAt.getTime();
  if (at !== anchor) return at < anchor;
  return candidate.id < position.id;
}

/** Decodes exactly what the service encoded, including its scope envelope. */
function decodeServiceCursor(cursor: string): { position: DecodedPosition; scope: unknown[] } {
  const decoded = decodeCursor(cursor);
  if (!decoded) throw new Error("service emitted an undecodable cursor");
  const scope: unknown = JSON.parse(decoded.id);
  if (!Array.isArray(scope)) throw new Error("service cursor carries no scope array");
  const rowId = scope[4];
  if (typeof rowId !== "string") throw new Error("service cursor carries no row id");
  return { position: { sortValue: decoded.sortValue, id: rowId }, scope };
}

interface Harness {
  db: Db;
  selectCalls: () => number;
  whereClauses: () => unknown[];
}

const TUPLE_BOUND = /\(\s*"invitations"\."created_at",\s*"invitations"\."id"\s*\)\s*<\s*\(\s*\$(\d+),\s*\$(\d+)\s*\)/;
const SINGLE_COLUMN_BOUND = /"invitations"\."created_at"\s*<\s*\$(\d+)/;

/**
 * The page boundary as the DATABASE would read it — parsed out of the rendered
 * SQL and its bound parameters, not out of the cursor the caller happened to
 * pass. Reading it from the cursor would make every walk below vacuous: the
 * fixture would page correctly even if the service emitted a predicate that
 * never mentioned the id tie-breaker.
 */
function keysetBoundFromSql(rendered: { sql: string; params: unknown[] }): DecodedPosition | { sortValue: string; id: null } | null {
  const asText = (slot: string | undefined): string => String(rendered.params[Number(slot) - 1]);

  const tuple = TUPLE_BOUND.exec(rendered.sql);
  if (tuple) return { sortValue: asText(tuple[1]), id: asText(tuple[2]) };

  const single = SINGLE_COLUMN_BOUND.exec(rendered.sql);
  if (single) return { sortValue: asText(single[1]), id: null };

  return null;
}

/**
 * A database stand-in that answers the keyset the way Postgres would: it applies
 * the bound the service actually emitted, sorts newest-first and returns at most
 * `limit + 1` rows. A service that pointed its next cursor at the discarded
 * sentinel row, or that dropped the id tie-breaker, produces a visibly different
 * walk through these fixtures.
 */
function makeHarness(rows: InvitationFixtureRow[]): Harness {
  const whereClauses: unknown[] = [];
  let selectCalls = 0;
  let requestedLimit = Number.POSITIVE_INFINITY;

  function visibleRows(): InvitationFixtureRow[] {
    const clause = whereClauses[0];
    const bound = clause === undefined ? null : keysetBoundFromSql(renderWhere(clause));
    const ordered = sortNewestFirst(rows);
    if (!bound) return ordered.slice(0, requestedLimit);
    if (bound.id === null) {
      const anchor = new Date(bound.sortValue).getTime();
      return ordered
        .filter((candidate) => candidate.createdAt.getTime() < anchor)
        .slice(0, requestedLimit);
    }
    return ordered
      .filter((candidate) => strictlyBefore(candidate, { sortValue: bound.sortValue, id: bound.id }))
      .slice(0, requestedLimit);
  }

  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(visibleRows()).then(resolve, reject);
    },
    catch(reject: (reason: unknown) => unknown) {
      return Promise.resolve(visibleRows()).catch(reject);
    },
    finally(onFinally: () => void) {
      return Promise.resolve(visibleRows()).finally(onFinally);
    },
  };

  for (const key of ["from", "orderBy", "offset", "leftJoin", "innerJoin"])
    (builder[key] as jest.Mock).mockReturnValue(builder);

  (builder.where as jest.Mock).mockImplementation((clause: unknown) => {
    whereClauses.push(clause);
    return builder;
  });
  (builder.limit as jest.Mock).mockImplementation((value: number) => {
    requestedLimit = value;
    return builder;
  });

  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCalls += 1;
      return builder;
    }),
  } as unknown as Db;

  return { db, selectCalls: () => selectCalls, whereClauses: () => whereClauses };
}

interface WalkedPage {
  ids: string[];
  hasMore: boolean;
  nextCursor: string | null;
  whereSql: string;
  whereParams: unknown[];
  selectCalls: number;
}

async function readPage(
  rows: InvitationFixtureRow[],
  cursor: string | undefined,
  limit: number,
): Promise<WalkedPage> {
  const harness = makeHarness(rows);
  const service = new InvitationsReadService(harness.db);
  const page = await service.listPaginated("org-page", { cursor, limit });
  const rendered = renderWhere(harness.whereClauses()[0]);
  return {
    ids: page.data.map((r) => r.id),
    hasMore: page.pagination.hasMore,
    nextCursor: page.pagination.nextCursor,
    whereSql: rendered.sql,
    whereParams: rendered.params,
    selectCalls: harness.selectCalls(),
  };
}

async function walkAllPages(
  rows: InvitationFixtureRow[],
  limit: number,
): Promise<WalkedPage[]> {
  const pages: WalkedPage[] = [];
  let cursor: string | undefined = undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page: WalkedPage = await readPage(rows, cursor, limit);
    pages.push(page);
    if (!page.hasMore || !page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("cursor walk did not terminate — the list is repeating a page");
}

const SAME_INSTANT = new Date("2026-09-01T10:00:00.000Z");

const EQUAL_TIMESTAMP_ROWS = [
  row("inv-01", SAME_INSTANT),
  row("inv-02", SAME_INSTANT),
  row("inv-03", SAME_INSTANT),
  row("inv-04", SAME_INSTANT),
  row("inv-05", SAME_INSTANT),
];

const DISTINCT_TIMESTAMP_ROWS = [
  row("inv-a", new Date("2026-09-01T10:00:00.000Z")),
  row("inv-b", new Date("2026-09-02T10:00:00.000Z")),
  row("inv-c", new Date("2026-09-03T10:00:00.000Z")),
  row("inv-d", new Date("2026-09-04T10:00:00.000Z")),
  row("inv-e", new Date("2026-09-05T10:00:00.000Z")),
  row("inv-f", new Date("2026-09-06T10:00:00.000Z")),
  row("inv-g", new Date("2026-09-07T10:00:00.000Z")),
];

describe("InvitationsReadService.listPaginated — more than two pages", () => {
  it("walks seven distinct-timestamp rows over three pages with no repeat and no skip", async () => {
    const pages = await walkAllPages(DISTINCT_TIMESTAMP_ROWS, 3);

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.ids)).toEqual([
      ["inv-g", "inv-f", "inv-e"],
      ["inv-d", "inv-c", "inv-b"],
      ["inv-a"],
    ]);
    expect(pages.slice(0, 2).every((p) => p.hasMore)).toBe(true);
    expect(pages[2]?.hasMore).toBe(false);
    expect(pages[2]?.nextCursor).toBeNull();

    const seen = pages.flatMap((p) => p.ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(DISTINCT_TIMESTAMP_ROWS.map((r) => r.id)));
  });

  it("never repeats the first page after paging forward", async () => {
    const pages = await walkAllPages(DISTINCT_TIMESTAMP_ROWS, 3);
    const firstPage = pages[0]?.ids ?? [];

    for (const later of pages.slice(1))
      for (const id of later.ids) expect(firstPage).not.toContain(id);
  });
});

describe("InvitationsReadService.listPaginated — equal createdAt timestamps", () => {
  it("pages five rows sharing one timestamp without repeating or skipping any", async () => {
    const pages = await walkAllPages(EQUAL_TIMESTAMP_ROWS, 2);

    expect(pages.map((p) => p.ids)).toEqual([
      ["inv-05", "inv-04"],
      ["inv-03", "inv-02"],
      ["inv-01"],
    ]);

    const seen = pages.flatMap((p) => p.ids);
    expect(seen).toHaveLength(EQUAL_TIMESTAMP_ROWS.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("binds a two-column (created_at, id) keyset, not a timestamp alone", async () => {
    const firstPage = await readPage(EQUAL_TIMESTAMP_ROWS, undefined, 2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await readPage(EQUAL_TIMESTAMP_ROWS, firstPage.nextCursor ?? undefined, 2);

    expect(secondPage.whereSql).toContain('"invitations"."created_at"');
    expect(secondPage.whereSql).toContain('"invitations"."id"');
    expect(secondPage.whereSql).toMatch(/\(\s*"invitations"\."created_at",\s*"invitations"\."id"\s*\)\s*<\s*\(/);

    const boundIds = secondPage.whereParams.filter((p) => typeof p === "string");
    expect(boundIds).toContain("inv-04");

    const boundInstants = secondPage.whereParams
      .map((p) => (p instanceof Date ? p.getTime() : new Date(String(p)).getTime()))
      .filter((instant) => !Number.isNaN(instant));
    expect(boundInstants).toContain(SAME_INSTANT.getTime());
  });

  it("mints the next cursor from the last KEPT row, never from the over-fetched sentinel", async () => {
    const firstPage = await readPage(EQUAL_TIMESTAMP_ROWS, undefined, 2);
    const { position } = decodeServiceCursor(firstPage.nextCursor ?? "");

    expect(firstPage.ids[firstPage.ids.length - 1]).toBe("inv-04");
    expect(position.id).toBe("inv-04");
    expect(position.id).not.toBe("inv-03");
  });

  it("a createdAt-only cursor would skip every tied row — the constructed bite", () => {
    const anchor: DecodedPosition = {
      sortValue: SAME_INSTANT.toISOString(),
      id: "inv-04",
    };

    const twoColumn = sortNewestFirst(EQUAL_TIMESTAMP_ROWS).filter((candidate) =>
      strictlyBefore(candidate, anchor),
    );
    const timestampOnly = sortNewestFirst(EQUAL_TIMESTAMP_ROWS).filter(
      (candidate) => candidate.createdAt.getTime() < new Date(anchor.sortValue).getTime(),
    );

    expect(twoColumn.map((r) => r.id)).toEqual(["inv-03", "inv-02", "inv-01"]);
    expect(timestampOnly).toHaveLength(0);
  });
});

describe("InvitationsReadService.listPaginated — replaying a cursor (back and next)", () => {
  it("replaying the cursor that produced a page returns that page unchanged", async () => {
    const pages = await walkAllPages(EQUAL_TIMESTAMP_ROWS, 2);
    const cursorForPageTwo = pages[0]?.nextCursor ?? undefined;
    const cursorForPageThree = pages[1]?.nextCursor ?? undefined;

    const replayedTwo = await readPage(EQUAL_TIMESTAMP_ROWS, cursorForPageTwo, 2);
    const replayedThree = await readPage(EQUAL_TIMESTAMP_ROWS, cursorForPageThree, 2);
    const replayedOne = await readPage(EQUAL_TIMESTAMP_ROWS, undefined, 2);

    expect(replayedTwo.ids).toEqual(pages[1]?.ids);
    expect(replayedThree.ids).toEqual(pages[2]?.ids);
    expect(replayedOne.ids).toEqual(pages[0]?.ids);
  });

  it("stepping back from the last page and forward again lands on the same rows", async () => {
    const pages = await walkAllPages(DISTINCT_TIMESTAMP_ROWS, 3);
    const backToPageTwo = await readPage(
      DISTINCT_TIMESTAMP_ROWS,
      pages[0]?.nextCursor ?? undefined,
      3,
    );
    const forwardAgain = await readPage(
      DISTINCT_TIMESTAMP_ROWS,
      backToPageTwo.nextCursor ?? undefined,
      3,
    );

    expect(backToPageTwo.ids).toEqual(["inv-d", "inv-c", "inv-b"]);
    expect(forwardAgain.ids).toEqual(["inv-a"]);
  });
});

describe("InvitationsReadService.listPaginated — cursor scope rejection", () => {
  function serviceOver(rows: InvitationFixtureRow[]): InvitationsReadService {
    return new InvitationsReadService(makeHarness(rows).db);
  }

  function cursorWithScope(scope: readonly unknown[]): string {
    return encodeCursor({
      sortValue: SAME_INSTANT.toISOString(),
      id: JSON.stringify(scope),
    });
  }

  it("rejects a cursor minted for a different organization", async () => {
    const foreign = cursorWithScope(["org-other", false, null, null, "inv-04"]);
    await expect(
      serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", { cursor: foreign }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a cursor minted under a different search query", async () => {
    const mintedWithSearch = cursorWithScope(["org-page", false, null, "alice", "inv-04"]);

    await expect(
      serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", { cursor: mintedWithSearch }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", {
        cursor: mintedWithSearch,
        q: "bob",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a cursor minted under a different includeAccepted scope", async () => {
    const mintedIncludingAccepted = cursorWithScope(["org-page", true, null, null, "inv-04"]);
    await expect(
      serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", {
        cursor: mintedIncludingAccepted,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a cursor minted under a different status filter", async () => {
    const mintedPending = cursorWithScope(["org-page", false, "pending", null, "inv-04"]);
    await expect(
      serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", {
        cursor: mintedPending,
        status: "revoked",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a hand-edited cursor whose scope envelope is the wrong shape", async () => {
    const truncated = cursorWithScope(["org-page", false, null, null]);
    const noRowId = cursorWithScope(["org-page", false, null, null, ""]);
    const notJson = encodeCursor({ sortValue: SAME_INSTANT.toISOString(), id: "not-json" });

    for (const cursor of [truncated, noRowId, notJson])
      await expect(
        serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", { cursor }),
      ).rejects.toThrow(BadRequestException);
  });

  it("accepts the matching scope so the rejections above are not vacuous", async () => {
    const matching = cursorWithScope(["org-page", false, null, null, "inv-04"]);
    const page = await serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", {
      cursor: matching,
    });
    expect(page.pagination.limit).toBe(20);
  });

  it("a cursor minted under the search scope is accepted only with that same search", async () => {
    const mintedWithSearch = cursorWithScope(["org-page", false, null, "alice", "inv-04"]);
    const page = await serviceOver(EQUAL_TIMESTAMP_ROWS).listPaginated("org-page", {
      cursor: mintedWithSearch,
      q: "alice",
    });
    expect(page.data.length).toBeGreaterThanOrEqual(0);
  });
});

describe("InvitationsReadService.listPaginated — no unbounded COUNT query", () => {
  it("issues exactly one select per page and over-fetches by one instead of counting", async () => {
    const harness = makeHarness(EQUAL_TIMESTAMP_ROWS);
    const service = new InvitationsReadService(harness.db);

    const page = await service.listPaginated("org-page", { limit: 2 });

    expect(harness.selectCalls()).toBe(1);
    expect(page.pagination).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(page.pagination).not.toHaveProperty("total");
    expect(page.pagination).not.toHaveProperty("totalPages");
    expect(page.pagination).not.toHaveProperty("page");
  });

  it("emits no aggregate in the rendered WHERE clause of any page in a three-page walk", async () => {
    const pages = await walkAllPages(EQUAL_TIMESTAMP_ROWS, 2);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.selectCalls).toBe(1);
      expect(page.whereSql.toLowerCase()).not.toContain("count(");
    }
  });

  it("caps the page size at 100 however large a limit the caller asks for", async () => {
    const harness = makeHarness(EQUAL_TIMESTAMP_ROWS);
    const service = new InvitationsReadService(harness.db);
    const page = await service.listPaginated("org-page", { limit: 5000 });
    expect(page.pagination.limit).toBe(100);
  });
});
