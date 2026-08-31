import type { Db } from "../../db/drizzle.module";
import { NotificationsReadService } from "./notifications-read.service";
import type { ListInput } from "./dto/notification.schemas";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
    groupBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeFrom(allWhereArgs: unknown[]): object {
  const where = jest.fn().mockImplementation((arg: unknown) => {
    allWhereArgs.push(arg);
    return makeChain();
  });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(allWhereArgs));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(allWhereArgs));
  return self;
}

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => makeFrom(allWhereArgs)),
    })),
  } as unknown as Db;
  return { db, allWhereArgs };
}

function makeCache() {
  return {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: unknown, _key: unknown, fn: () => unknown) => fn(),
    ),
  } as never;
}

function hasSqlValue(allWhereArgs: unknown[], predicate: (v: unknown) => boolean): boolean {
  return allWhereArgs.flatMap((w) => sqlValues(w)).some(predicate);
}

describe("NotificationsReadService — inbox section SQL predicates", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("MENTIONS section", () => {
    it("includes a '%mention%' ilike predicate in the WHERE clause", async () => {
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", "user-1", { section: "MENTIONS", limit: 20 } as ListInput);

      const found = hasSqlValue(
        allWhereArgs,
        (v) => typeof v === "string" && v.toLowerCase().includes("mention"),
      );
      expect(found).toBe(true);
    });

    it("always includes the caller orgId in the WHERE clause", async () => {
      const ORG = "org-mentions-scope";
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list(ORG, "user-1", { section: "MENTIONS", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => v === ORG)).toBe(true);
    });

    it("always includes the caller userId in the WHERE clause", async () => {
      const USER = "user-mentions-scope";
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", USER, { section: "MENTIONS", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => v === USER)).toBe(true);
    });
  });

  describe("ASSIGNED_TO_ME section", () => {
    it("includes an '%assigned%' ilike predicate in the WHERE clause", async () => {
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", "user-1", { section: "ASSIGNED_TO_ME", limit: 20 } as ListInput);

      const found = hasSqlValue(
        allWhereArgs,
        (v) => typeof v === "string" && v.toLowerCase().includes("assigned"),
      );
      expect(found).toBe(true);
    });

    it("always includes the caller orgId in the WHERE clause", async () => {
      const ORG = "org-assigned-scope";
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list(ORG, "user-1", { section: "ASSIGNED_TO_ME", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => v === ORG)).toBe(true);
    });

    it("always includes the caller userId in the WHERE clause", async () => {
      const USER = "user-assigned-scope";
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", USER, { section: "ASSIGNED_TO_ME", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => v === USER)).toBe(true);
    });
  });

  describe("APPROVALS section", () => {
    it("uses WORKFLOW category predicate, not a mention or assigned pattern", async () => {
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", "user-1", { section: "APPROVALS", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => v === "WORKFLOW")).toBe(true);
      expect(hasSqlValue(allWhereArgs, (v) => typeof v === "string" && v.toLowerCase().includes("mention"))).toBe(false);
      expect(hasSqlValue(allWhereArgs, (v) => typeof v === "string" && v.toLowerCase().includes("assigned"))).toBe(false);
    });
  });

  describe("ALL section", () => {
    it("does not include any mention or assigned predicate", async () => {
      const { db, allWhereArgs } = makeDb();
      const svc = new NotificationsReadService(db, makeCache());

      await svc.list("org-1", "user-1", { section: "ALL", limit: 20 } as ListInput);

      expect(hasSqlValue(allWhereArgs, (v) => typeof v === "string" && v.toLowerCase().includes("mention"))).toBe(false);
      expect(hasSqlValue(allWhereArgs, (v) => typeof v === "string" && v.toLowerCase().includes("assigned"))).toBe(false);
    });
  });

  describe("cross-tenant isolation — all sections", () => {
    it("a cross-org request carries only its own orgId in every section's WHERE clause", async () => {
      const ORG_A = "org-alpha";
      const ORG_B = "org-beta";

      for (const section of ["ALL", "MENTIONS", "ASSIGNED_TO_ME", "APPROVALS"] as const) {
        const { db, allWhereArgs } = makeDb();
        const svc = new NotificationsReadService(db, makeCache());

        await svc.list(ORG_A, "user-1", { section, limit: 20 } as ListInput);

        expect(hasSqlValue(allWhereArgs, (v) => v === ORG_A)).toBe(true);
        expect(hasSqlValue(allWhereArgs, (v) => v === ORG_B)).toBe(false);
      }
    });
  });

  describe("cross-user isolation — all sections", () => {
    it("query carries the caller userId, not any other user", async () => {
      const USER_A = "user-alpha";
      const USER_B = "user-beta";

      for (const section of ["ALL", "MENTIONS", "ASSIGNED_TO_ME", "APPROVALS"] as const) {
        const { db, allWhereArgs } = makeDb();
        const svc = new NotificationsReadService(db, makeCache());

        await svc.list("org-1", USER_A, { section, limit: 20 } as ListInput);

        expect(hasSqlValue(allWhereArgs, (v) => v === USER_A)).toBe(true);
        expect(hasSqlValue(allWhereArgs, (v) => v === USER_B)).toBe(false);
      }
    });
  });
});
