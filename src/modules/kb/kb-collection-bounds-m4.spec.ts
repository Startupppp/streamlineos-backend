import "reflect-metadata";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { KbSourcesService } from "./wiki/kb-sources.service";
import { KbSpacesService } from "./wiki/kb-spaces.service";
import { KbPageTrashQueryService } from "./wiki/kb-page-trash-query.service";
import { encodeCursor } from "../../common/pagination/cursor";
import type { KbSourcesListQuery } from "./wiki/dto/kb-sources.schemas";
import type { ListSpacesQuery } from "./core/dto/kb.schemas";
import type { TrashPagesQuery } from "./wiki/dto/kb-pages.schemas";

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

interface CapturedQuery {
  where: unknown;
  limit: number;
}

function makeCapturingChain(captured: Partial<CapturedQuery>) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (clause: unknown) => {
    captured.where = clause;
    return chain;
  };
  chain.groupBy = () => chain;
  chain.orderBy = () => chain;
  chain.limit = (n: number) => {
    captured.limit = n;
    return Promise.resolve([]);
  };
  return chain;
}

function makeSourcesDb(captured: Partial<CapturedQuery>): Db {
  return {
    select: () => makeCapturingChain(captured),
  } as unknown as Db;
}

function makeSpacesDb(spacesCaptured: Partial<CapturedQuery>): Db {
  const chain = makeCapturingChain(spacesCaptured);
  const emptyChain: Record<string, unknown> = {};
  emptyChain.from = () => emptyChain;
  emptyChain.where = () => emptyChain;
  emptyChain.groupBy = () => emptyChain;
  emptyChain.orderBy = () => emptyChain;
  emptyChain.limit = () => Promise.resolve([]);
  emptyChain.leftJoin = () => emptyChain;
  emptyChain.innerJoin = () => emptyChain;

  let callCount = 0;
  return {
    select: () => {
      callCount += 1;
      return callCount === 1 ? chain : emptyChain;
    },
  } as unknown as Db;
}

function makeTrashDb(captured: Partial<CapturedQuery>): Db {
  return {
    select: () => makeCapturingChain(captured),
  } as unknown as Db;
}

const noopAuthz = {
  resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [] }),
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  invalidateSpaceScope: jest.fn().mockResolvedValue(undefined),
} as never;

const noopIndexing = {
  bumpSpaceAclRevision: jest.fn().mockResolvedValue(undefined),
} as never;

function makeSourcesService(captured: Partial<CapturedQuery>): KbSourcesService {
  return new KbSourcesService(
    makeSourcesDb(captured),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function makeSpacesService(captured: Partial<CapturedQuery>): KbSpacesService {
  return new KbSpacesService(makeSpacesDb(captured), noopIndexing, noopAuthz);
}

function makeTrashService(captured: Partial<CapturedQuery>): KbPageTrashQueryService {
  return new KbPageTrashQueryService(makeTrashDb(captured), noopAuthz);
}

function makeUser() {
  return {
    orgId: "org-abc",
    userId: "user-1",
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

describe("kb-collection-bounds-m4: cursor safety for integer-pk sources list", () => {
  it("a valid timestamp-format cursor activates the keyset filter in the WHERE clause", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeSourcesService(captured);
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "42",
    });
    const query: KbSourcesListQuery = { cursor, limit: 10 };
    await svc.list("org-abc", query);
    expect(captured.where).toBeDefined();
    const sql = renderSql(captured.where);
    expect(sql).toContain("::timestamp");
  });

  it("a cursor whose id segment is not a positive integer is treated as no cursor — the keyset filter is absent from the WHERE clause", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeSourcesService(captured);
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "not-an-integer",
    });
    const query: KbSourcesListQuery = { cursor, limit: 10 };
    await svc.list("org-abc", query);
    expect(captured.where).toBeDefined();
    const sql = renderSql(captured.where);
    expect(sql).not.toContain("::timestamp");
  });

  it("a cursor whose id segment is zero is treated as no cursor", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeSourcesService(captured);
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "0",
    });
    const query: KbSourcesListQuery = { cursor, limit: 10 };
    await svc.list("org-abc", query);
    const sql = renderSql(captured.where);
    expect(sql).not.toContain("::timestamp");
  });

  it("fetches limit+1 rows so the sentinel algorithm can signal hasMore without a count query", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeSourcesService(captured);
    const query: KbSourcesListQuery = { limit: 20 };
    await svc.list("org-abc", query);
    expect(captured.limit).toBe(21);
  });
});

describe("kb-collection-bounds-m4: cursor safety for integer-pk spaces list", () => {
  function makeSpacesAuthz() {
    return {
      resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [1, 2, 3] }),
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      invalidateSpaceScope: jest.fn().mockResolvedValue(undefined),
    } as never;
  }

  function makeCapturingScope() {
    let capturedDomain: unknown[] = [];
    const scope = {
      denied: false,
      compose: (opts: { and: unknown[] }, ok: (v: { sql: unknown }) => unknown) => {
        capturedDomain = opts.and;
        return ok({ sql: sql`true` });
      },
    } as never;
    return { scope, getDomain: () => capturedDomain };
  }

  it("a cursor whose id segment is not a positive integer is treated as no cursor — keyset filter absent from domain", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = new KbSpacesService(makeSpacesDb(captured), noopIndexing, makeSpacesAuthz());
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "not-an-integer",
    });
    const query: ListSpacesQuery = { cursor, limit: 10 };
    const { scope, getDomain } = makeCapturingScope();
    await svc.list(makeUser(), scope, query);
    const domainSql = getDomain().map(renderSql).join(" ");
    expect(domainSql).not.toContain("::timestamp");
  });

  it("a cursor whose id segment is zero is treated as no cursor", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = new KbSpacesService(makeSpacesDb(captured), noopIndexing, makeSpacesAuthz());
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "0",
    });
    const query: ListSpacesQuery = { cursor, limit: 10 };
    const { scope, getDomain } = makeCapturingScope();
    await svc.list(makeUser(), scope, query);
    const domainSql = getDomain().map(renderSql).join(" ");
    expect(domainSql).not.toContain("::timestamp");
  });

  it("a valid timestamp cursor activates the keyset filter in the domain", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = new KbSpacesService(makeSpacesDb(captured), noopIndexing, makeSpacesAuthz());
    const cursor = encodeCursor({
      sortValue: "2025-01-01T00:00:00.000000",
      id: "7",
    });
    const query: ListSpacesQuery = { cursor, limit: 10 };
    const { scope, getDomain } = makeCapturingScope();
    await svc.list(makeUser(), scope, query);
    const domainSql = getDomain().map(renderSql).join(" ");
    expect(domainSql).toContain("::timestamp");
  });

  it("fetches limit+1 rows so the sentinel algorithm can signal hasMore", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = new KbSpacesService(makeSpacesDb(captured), noopIndexing, makeSpacesAuthz());
    const query: ListSpacesQuery = { limit: 15 };
    const { scope } = makeCapturingScope();
    await svc.list(makeUser(), scope, query);
    expect(captured.limit).toBe(16);
  });
});

describe("kb-collection-bounds-m4: trash list cursor uses timestamp-validated decoder", () => {
  it("the decodeTimestampCursor path validates microsecond format — a non-microsecond cursor is treated as no cursor", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeTrashService(captured);
    const cursor = encodeCursor({
      sortValue: "not-a-timestamp",
      id: "5",
    });
    const query: TrashPagesQuery = { cursor, limit: 10 };
    await svc.getTrash(makeUser(), query);
    expect(captured.where).toBeDefined();
    const rendered = renderSql(captured.where);
    expect(rendered).not.toContain("::timestamp");
  });

  it("a valid microsecond-precision cursor activates the keyset filter", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeTrashService(captured);
    const cursor = encodeCursor({
      sortValue: "2025-06-01T12:00:00.000000",
      id: "99",
    });
    const query: TrashPagesQuery = { cursor, limit: 10 };
    await svc.getTrash(makeUser(), query);
    const rendered = renderSql(captured.where);
    expect(rendered).toContain("::timestamp");
  });

  it("fetches limit+1 rows for the hasMore sentinel", async () => {
    const captured: Partial<CapturedQuery> = {};
    const svc = makeTrashService(captured);
    const query: TrashPagesQuery = { limit: 25 };
    await svc.getTrash(makeUser(), query);
    expect(captured.limit).toBe(26);
  });
});
