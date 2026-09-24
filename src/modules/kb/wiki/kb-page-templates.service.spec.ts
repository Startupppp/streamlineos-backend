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
  function makeListDb(rows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(rows);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit }),
          }),
        }),
      }),
    } as unknown as Db;
    return { db, limit };
  }

  function templateNamed(id: number, name: string) {
    return { ...TEMPLATE_ROW, id, name };
  }

  it("asks for one row beyond the page so it can tell whether another page exists without counting", async () => {
    const { db, limit } = makeListDb([]);

    await new KbPageTemplatesService(db).list("org-1", { limit: 50 });

    expect(limit).toHaveBeenCalledWith(51);
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
    const { db, limit } = makeListDb([]);

    await new KbPageTemplatesService(db).list("org-1", { limit: PAGE_SIZE_CAP });

    expect(limit).toHaveBeenCalledWith(PAGE_SIZE_CAP + 1);
    expect(PAGE_SIZE_CAP).toBe(100);
  });
});
