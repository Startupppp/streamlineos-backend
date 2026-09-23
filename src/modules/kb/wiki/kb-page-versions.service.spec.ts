import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { encodeCursor } from "../../../common/pagination/cursor";

function makeAuthMock() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };
}

const dialect = new PgDialect();

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v as object)) return [];
  seen.add(v as object);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    principal: undefined,
  } as never;
}

type VersionRow = {
  id: number;
  versionNumber: number;
  orgId: string;
  pageId: number;
  title: string;
  content: null;
  contentText: null;
  changeSummary: null;
  authorId: null;
  authorMembershipId: null;
  authorName: null;
  createdAt: Date;
};

function makeVersionRows(count: number, startId = count): VersionRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId - i,
    versionNumber: startId - i,
    orgId: "org-1",
    pageId: 1,
    title: `Version ${startId - i}`,
    content: null,
    contentText: null,
    changeSummary: null,
    authorId: null,
    authorMembershipId: null,
    authorName: null,
    createdAt: new Date(),
  }));
}

function makeDb(opts: { pageFound: boolean; versionRows?: unknown[]; capturedWheres?: unknown[] }) {
  const capturedWheres = opts.capturedWheres ?? [];
  const versionRows = opts.versionRows ?? [];

  const joinChain: Record<string, jest.Mock> = {
    where: jest.fn((w: unknown) => {
      capturedWheres.push(w);
      return Promise.resolve([]);
    }),
  };
  joinChain.innerJoin = jest.fn(() => joinChain);

  const versionsChain = {
    orderBy: jest.fn().mockReturnThis() as jest.Mock,
    limit: jest.fn(() => Promise.resolve(versionRows)),
  };

  const leftJoinChain = {
    where: jest.fn((w: unknown) => {
      capturedWheres.push(w);
      return versionsChain;
    }),
  };

  return {
    db: {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue(opts.pageFound ? { id: 1 } : null),
        },
      },
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => joinChain),
          leftJoin: jest.fn(() => leftJoinChain),
        })),
      })),
    } as unknown as Db,
    capturedWheres,
    versionsChain,
  };
}

describe("KbPageVersionsService.listVersions — keyset pagination", () => {
  it("(d) with no cursor: WHERE has org and page predicates, no keyset expression", async () => {
    const { db, capturedWheres } = makeDb({ pageFound: true });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);

    await svc.listVersions(makeUser(), 1);

    const versionWhere = capturedWheres[capturedWheres.length - 1];
    const { sql: text } = dialect.sqlToQuery(versionWhere as never);
    expect(text).not.toMatch(/<|>/);
  });

  it("(d) with cursor: WHERE carries the (version_number, id) tuple predicate", async () => {
    const { db, capturedWheres } = makeDb({ pageFound: true });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);
    const cursor = encodeCursor({ sortValue: "50", id: "99" });

    await svc.listVersions(makeUser(), 1, cursor);

    const versionWhere = capturedWheres[capturedWheres.length - 1];
    const { sql: text, params } = dialect.sqlToQuery(versionWhere as never);
    expect(text).toContain("version_number");
    expect(text).toContain("<");
    expect(params).toContain("50");
    expect(params).toContain(99);
  });

  it("(d) cursor order matches ORDER BY: keyset uses version_number, not created_at", async () => {
    const { db, capturedWheres } = makeDb({ pageFound: true });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);
    const cursor = encodeCursor({ sortValue: "7", id: "5" });

    await svc.listVersions(makeUser(), 1, cursor);

    const versionWhere = capturedWheres[capturedWheres.length - 1];
    const { sql: text } = dialect.sqlToQuery(versionWhere as never);
    expect(text).toContain("version_number");
    expect(text).not.toContain("created_at");
  });

  it("queries PAGE_SIZE + 1 rows to detect the next page", async () => {
    const { db, versionsChain } = makeDb({ pageFound: true });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);

    await svc.listVersions(makeUser(), 1);

    expect(versionsChain.limit).toHaveBeenCalledWith(51);
  });

  it("(a) no cursor: returns first page with nextCursor when rows exceed PAGE_SIZE", async () => {
    const { db } = makeDb({ pageFound: true, versionRows: makeVersionRows(51, 55) });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);

    const page = await svc.listVersions(makeUser(), 1);

    expect(page.data).toHaveLength(50);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
    expect(page.pagination.limit).toBe(50);
  });

  it("(c) last page: reports hasMore false and nextCursor null", async () => {
    const { db } = makeDb({ pageFound: true, versionRows: makeVersionRows(5) });
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);

    const page = await svc.listVersions(makeUser(), 1);

    expect(page.data).toHaveLength(5);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("(b) nextCursor from page1 yields page2 with no overlap and no gap", async () => {
    const page1Fixture = makeVersionRows(51, 55);
    const { db: db1 } = makeDb({ pageFound: true, versionRows: page1Fixture });
    const svc1 = new KbPageVersionsService(db1, makeAuthMock() as never);
    const page1 = await svc1.listVersions(makeUser(), 1);

    expect(page1.data).toHaveLength(50);
    const firstId = page1.data[0]?.id;
    const lastId = page1.data[49]?.id;
    expect(firstId).toBe(55);
    expect(lastId).toBe(6);

    const nextCursor = page1.pagination.nextCursor;
    expect(nextCursor).not.toBeNull();
    if (!nextCursor) return;

    const page2Fixture = makeVersionRows(5, 5);
    const capturedPage2Wheres: unknown[] = [];
    const { db: db2 } = makeDb({ pageFound: true, versionRows: page2Fixture, capturedWheres: capturedPage2Wheres });
    const svc2 = new KbPageVersionsService(db2, makeAuthMock() as never);
    const page2 = await svc2.listVersions(makeUser(), 1, nextCursor);

    expect(page2.data).toHaveLength(5);
    const page2FirstId = page2.data[0]?.id;
    const page2LastId = page2.data[4]?.id;
    expect(page2FirstId).toBe(5);
    expect(page2LastId).toBe(1);
    expect(page2.pagination.hasMore).toBe(false);

    const page2Where = capturedPage2Wheres[capturedPage2Wheres.length - 1];
    const { sql: text, params } = dialect.sqlToQuery(page2Where as never);
    expect(text).toContain("<");
    expect(params).toContain("6");
    expect(params).toContain(6);
  });
});
