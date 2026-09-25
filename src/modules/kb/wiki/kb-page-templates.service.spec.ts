import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

function makeUser(over: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-1",
    orgId: "org-1",
    role: "member",
    isOrgOwner: false,
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

const TEMPLATE_ROW = {
  id: 1,
  orgId: "org-1",
  name: "My Template",
  icon: null,
  description: null,
  content: null,
  createdById: "u-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeSelectSequence(
  resultsByCall: unknown[][],
  capture?: { conditions: unknown[] },
): { select: jest.Mock; limits: jest.Mock[] } {
  let call = 0;
  const limits: jest.Mock[] = [];
  const select = jest.fn().mockImplementation(() => {
    const rows = resultsByCall[call] ?? [];
    call += 1;
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((cond: unknown) => {
          capture?.conditions.push(cond);
          const limitMock = jest.fn().mockResolvedValue(rows);
          limits.push(limitMock);
          return Object.assign(Promise.resolve(rows), {
            orderBy: jest.fn().mockReturnValue({ limit: limitMock }),
          });
        }),
      }),
    };
  });
  return { select, limits };
}

function makeSelectOwnerChain(row: (Record<string, unknown> & { createdById?: string | null }) | null) {
  const ownerRows =
    row && row.createdById
      ? [{ id: row.createdById, name: "Owner Name" }]
      : [];
  return makeSelectSequence([row ? [row] : [], ownerRows]).select;
}

function makeInsertChain(result: unknown[] = [TEMPLATE_ROW]): {
  db: Db;
  returning: jest.Mock;
  values: jest.Mock;
  findFirst: jest.Mock;
} {
  const returning = jest.fn().mockResolvedValue(result);
  const values = jest.fn().mockReturnValue({ returning });
  const findFirst = jest.fn().mockResolvedValue({ id: 5, content: null, icon: null });
  const db = {
    query: { kbPages: { findFirst } },
    insert: jest.fn().mockReturnValue({ values }),
    select: makeSelectOwnerChain(result[0] ? (result[0] as Record<string, unknown>) : null),
  } as unknown as Db;
  return { db, returning, values, findFirst };
}

function makeDeleteChain(rows: Array<{ id: number }>): Db {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  return { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
}

const UNIQUE_VIOLATION = Object.assign(new Error("Failed query"), {
  cause: { code: "23505" },
});

describe("KbPageTemplatesService.create", () => {
  it("throws NotFoundException when the source page does not exist in the org", async () => {
    const { db, findFirst } = makeInsertChain();
    findFirst.mockResolvedValue(null);
    const svc = new KbPageTemplatesService(db);

    await expect(
      svc.create(makeUser(), { fromPageId: 99, name: "T" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the created template when the source page exists in the org", async () => {
    const { db } = makeInsertChain();
    const svc = new KbPageTemplatesService(db);

    const result = await svc.create(makeUser(), { fromPageId: 5, name: "My Template" });

    expect(result).toMatchObject({ id: 1, name: "My Template", orgId: "org-1" });
  });

  it("throws ConflictException when a template with the same name already exists", async () => {
    const returning = jest.fn().mockRejectedValue(UNIQUE_VIOLATION);
    const values = jest.fn().mockReturnValue({ returning });
    const findFirst = jest.fn().mockResolvedValue({ id: 5, content: null, icon: null });
    const db = {
      query: { kbPages: { findFirst } },
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new KbPageTemplatesService(db);

    await expect(
      svc.create(makeUser(), { fromPageId: 5, name: "Duplicate" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("re-throws non-unique errors from the insert", async () => {
    const networkError = new Error("connection lost");
    const returning = jest.fn().mockRejectedValue(networkError);
    const values = jest.fn().mockReturnValue({ returning });
    const findFirst = jest.fn().mockResolvedValue({ id: 5, content: null, icon: null });
    const db = {
      query: { kbPages: { findFirst } },
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new KbPageTemplatesService(db);

    await expect(
      svc.create(makeUser(), { fromPageId: 5, name: "T" }),
    ).rejects.toBe(networkError);
  });

  it("denies creation when the page is not visible to the caller's org (cross-tenant isolation)", async () => {
    const { db, findFirst } = makeInsertChain();
    findFirst.mockResolvedValue(null);
    const svc = new KbPageTemplatesService(db);

    await expect(
      svc.create(makeUser({ orgId: "org-attacker" }), { fromPageId: 5, name: "T" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("KbPageTemplatesService.remove", () => {
  it("throws NotFoundException when no row matches the org+id pair", async () => {
    const db = makeDeleteChain([]);
    const svc = new KbPageTemplatesService(db);

    await expect(svc.remove("org-1", 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolves without error when the template belongs to the org", async () => {
    const db = makeDeleteChain([{ id: 1 }]);
    const svc = new KbPageTemplatesService(db);

    await expect(svc.remove("org-1", 1)).resolves.toBeUndefined();
  });
});

describe("KbPageTemplatesService.list — paging", () => {
  function makeListDb(rows: unknown[], ownerRows: unknown[] = []) {
    const { select, limits } = makeSelectSequence([rows, ownerRows]);
    const db = { select } as unknown as Db;
    return { db, limits };
  }

  function templateNamed(id: number, name: string) {
    return { ...TEMPLATE_ROW, id, name };
  }

  it("asks for one row beyond the page so it can tell whether another page exists without counting", async () => {
    const { db, limits } = makeListDb([]);

    await new KbPageTemplatesService(db).list("org-1", { limit: 50 });

    expect(limits[0]).toHaveBeenCalledWith(51);
  });

  it("reports hasMore and a cursor when a further page exists, so templates past the first page stay reachable", async () => {
    const rows = [templateNamed(1, "Alpha"), templateNamed(2, "Beta"), templateNamed(3, "Gamma")];
    const { db } = makeListDb(rows);

    const page = await new KbPageTemplatesService(db).list("org-1", { limit: 2 });

    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("reports no cursor on the last page, so a reader stops instead of looping", async () => {
    const { db } = makeListDb([templateNamed(1, "Alpha")]);

    const page = await new KbPageTemplatesService(db).list("org-1", { limit: 50 });

    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("never exceeds the shared page-size cap, so no caller can invent a larger read", async () => {
    const { db, limits } = makeListDb([]);

    await new KbPageTemplatesService(db).list("org-1", { limit: PAGE_SIZE_CAP });

    expect(limits[0]).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
    expect(PAGE_SIZE_CAP).toBe(100);
  });

  it("returns the creator's display name alongside each template", async () => {
    const { db } = makeListDb(
      [templateNamed(1, "Alpha")],
      [{ id: TEMPLATE_ROW.createdById, name: "Jamie Doe" }],
    );

    const page = await new KbPageTemplatesService(db).list("org-1", { limit: 50 });

    expect(page.data[0]).toMatchObject({ createdByName: "Jamie Doe" });
  });
});

function sqlStringValues(v: unknown, seen = new Set<object>()): string[] {
  if (typeof v === "string") return [v];
  if (v === null || v === undefined || typeof v !== "object") return [];
  if (seen.has(v)) return [];
  seen.add(v);
  if (Array.isArray(v)) return v.flatMap((i) => sqlStringValues(i, seen));
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlStringValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlStringValues(r.value, seen) : []),
  ];
}

describe("KbPageTemplatesService.list — q search", () => {
  it("passes a trailing-wildcard ilike condition into the where clause when q is provided, never a leading wildcard", async () => {
    const capture = { conditions: [] as unknown[] };
    const { select } = makeSelectSequence([[], []], capture);
    const db = { select } as unknown as Db;

    await new KbPageTemplatesService(db).list("org-1", { limit: 50, q: "meeting" });

    const values = sqlStringValues(capture.conditions);
    expect(values).toContain("meeting%");
    expect(values).not.toContain("%meeting%");
    expect(values).not.toContain("%meeting");
  });
});

describe("KbPageTemplatesService.update", () => {
  it("throws NotFoundException when no row matches the org+id pair", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
    const svc = new KbPageTemplatesService(db);

    await expect(svc.update("org-1", 99, { name: "New name" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("renames the template and returns the refreshed row with its owner", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      update: jest.fn().mockReturnValue({ set }),
      select: makeSelectOwnerChain({
        ...TEMPLATE_ROW,
        name: "Renamed",
        createdByName: "Owner Name",
      }),
    } as unknown as Db;
    const svc = new KbPageTemplatesService(db);

    const result = await svc.update("org-1", 1, { name: "Renamed" });

    expect(set).toHaveBeenCalledWith({ name: "Renamed" });
    expect(result).toMatchObject({ name: "Renamed", createdByName: "Owner Name" });
  });

  it("throws ConflictException when the rename collides with an existing template name", async () => {
    const returning = jest.fn().mockRejectedValue(UNIQUE_VIOLATION);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const db = { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
    const svc = new KbPageTemplatesService(db);

    await expect(svc.update("org-1", 1, { name: "Duplicate" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
