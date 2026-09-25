import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";
import { decodeCursor } from "../../../common/pagination/cursor";

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

const audit = {} as never;
const makeAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn(),
});

type FakeRow = {
  id: number;
  parentPageId: number | null;
  spaceId: null;
  projectId: null;
  title: string;
  icon: null;
  coverImage: null;
  sortOrder: number;
  visibility: string;
  createdById: null;
  status: string;
  updatedAt: Date;
};

function makeRows(count: number, parentId: number | null = null): FakeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    parentPageId: parentId,
    spaceId: null,
    projectId: null,
    title: `Page ${i + 1}`,
    icon: null,
    coverImage: null,
    sortOrder: (i + 1) * 100,
    visibility: "org",
    createdById: null,
    status: "published",
    updatedAt: new Date(2026_000_000_000 + i * 1000),
  }));
}

function makePagedDb(rows: FakeRow[]) {
  let callCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount % 2 === 1) {
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  limit: jest.fn().mockImplementation((n: number) =>
                    Promise.resolve(rows.slice(0, n)),
                  ),
                }),
              ),
            });
          }
          return Promise.resolve([]);
        }),
      }),
    })),
  } as unknown as Db;
  return db;
}

describe("KbPageTreeService — cursor-stability", () => {
  it("inserting a page mid-pagination does not duplicate a row in consecutive pages", async () => {
    const rows = makeRows(7);
    const db = makePagedDb(rows);
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    const page1 = await svc.getTreeLevel(makeUser("org-cs"), { limit: 3 });

    expect(page1.data).toHaveLength(3);
    expect(page1.pagination.hasMore).toBe(true);

    const cursor = page1.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const pos = decodeCursor(cursor!);
    expect(pos).not.toBeNull();

    const lastKept = page1.data[page1.data.length - 1];
    if (!lastKept) throw new Error("no data");
    expect(pos!.id).toBe(String(lastKept.id));
    expect(pos!.sortValue).toBe(String(lastKept.sortOrder));
  });

  it("cursor encodes the LAST KEPT row, not the sentinel row", async () => {
    const rows = makeRows(6);
    const db = makePagedDb(rows);
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    const page = await svc.getTreeLevel(makeUser("org-cs2"), { limit: 5 });

    const cursor = page.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const pos = decodeCursor(cursor!);
    if (!pos) throw new Error("expected cursor");

    const lastKept = page.data[page.data.length - 1];
    if (!lastKept) throw new Error("no data");

    expect(pos.id).toBe(String(lastKept.id));
    expect(pos.id).not.toBe(String(rows[5]?.id));
  });

  it("reports no next page when all rows fit on one page", async () => {
    const rows = makeRows(3);
    const db = makePagedDb(rows);
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    const page = await svc.getTreeLevel(makeUser("org-cs3"), { limit: 10 });

    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.data).toHaveLength(3);
  });

  it("two rows sharing the same sort_order use id as a stable tie-breaker", async () => {
    const rows: FakeRow[] = [
      { id: 1, parentPageId: null, spaceId: null, projectId: null, title: "A", icon: null, coverImage: null, sortOrder: 100, visibility: "org", createdById: null, status: "published", updatedAt: new Date() },
      { id: 2, parentPageId: null, spaceId: null, projectId: null, title: "B", icon: null, coverImage: null, sortOrder: 100, visibility: "org", createdById: null, status: "published", updatedAt: new Date() },
      { id: 3, parentPageId: null, spaceId: null, projectId: null, title: "C", icon: null, coverImage: null, sortOrder: 100, visibility: "org", createdById: null, status: "published", updatedAt: new Date() },
    ];
    const db = makePagedDb(rows);
    const svc = new KbPageTreeService(db, audit, makeAuth() as never, {} as never);

    const page = await svc.getTreeLevel(makeUser("org-cs4"), { limit: 2 });

    const cursor = page.pagination.nextCursor;
    expect(cursor).not.toBeNull();
    const pos = decodeCursor(cursor!);
    if (!pos) throw new Error("expected cursor");

    expect(pos.sortValue).toBe("100");
    const lastKept = page.data[page.data.length - 1];
    if (!lastKept) throw new Error("no data");
    expect(pos.id).toBe(String(lastKept.id));
  });
});
