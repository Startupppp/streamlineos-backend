import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import { ScopedRead } from "../access/scoped-read";
import { encodeCursor } from "../../common/pagination/cursor";
import {
  FeedbucketSubmissionsService,
  type FeedbucketMediaStorage,
} from "./feedbucket-submissions.service";
import { listSubmissionsQuerySchema } from "./feedbucket.schemas";

const ORG = "org-owner";
const ACTOR = "user-actor";

const storage: jest.Mocked<FeedbucketMediaStorage> = {
  deleteFileIfPresent: jest.fn(),
};

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (value instanceof Date) return [value.toISOString()];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function sqlColumns(value: unknown, seen = new Set<object>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { name?: unknown; table?: unknown; queryChunks?: unknown[] };
  if (typeof record.name === "string" && record.table !== undefined) return [record.name];
  if (Array.isArray(value)) return value.flatMap((item) => sqlColumns(item, seen));
  return Object.values(record).flatMap((item) => sqlColumns(item, seen));
}

interface ListHarness {
  db: Db;
  findMany: jest.Mock;
  select: jest.Mock;
  countWhere: jest.Mock;
  membershipFindFirst: jest.Mock;
}

function makeListHarness(rows: unknown[] = [], total = 0): ListHarness {
  const findMany = jest.fn().mockResolvedValue(rows);
  const countWhere = jest.fn().mockResolvedValue([{ total }]);
  const from = jest.fn().mockReturnValue({ where: countWhere });
  const select = jest.fn().mockReturnValue({ from });
  const membershipFindFirst = jest.fn().mockResolvedValue({ id: 42 });
  const db = {
    query: {
      feedbucketSubmissions: { findMany },
      organizationMembers: { findFirst: membershipFindFirst },
    },
    select,
  } as unknown as Db;
  return { db, findMany, select, countWhere, membershipFindFirst };
}

function makeService(db: Db): FeedbucketSubmissionsService {
  return new FeedbucketSubmissionsService(db, storage, {} as unknown as AccessService);
}

function parseQuery(raw: Record<string, unknown>) {
  const parsed = listSubmissionsQuerySchema.safeParse({ page: "1", limit: "20", ...raw });
  if (!parsed.success) throw new Error(`query fixture is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function row(id: number, createdAt: string) {
  return { id, createdAt: new Date(createdAt), orgId: ORG, message: "m", widget: null };
}

async function whereOf(raw: Record<string, unknown>, rows: unknown[] = []) {
  const harness = makeListHarness(rows);
  const read = ScopedRead.of(ORG, ACTOR, "all");
  const result = await makeService(harness.db).list(read, parseQuery(raw), 42);
  const call = harness.findMany.mock.calls[0]?.[0] as { where?: unknown; orderBy?: unknown; limit?: number; offset?: number };
  return { harness, call, result };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FeedbucketSubmissionsService.list — every filter is evaluated in SQL, not in loaded rows", () => {
  it("puts the tenant org id in the WHERE clause alongside every filter", async () => {
    const { call } = await whereOf({ status: "open" });
    expect(sqlValues(call.where)).toContain(ORG);
  });

  it("applies status in the generated WHERE clause", async () => {
    const { call } = await whereOf({ status: "in_progress" });
    expect(sqlValues(call.where)).toContain("in_progress");
  });

  it("applies type in the generated WHERE clause", async () => {
    const { call } = await whereOf({ type: "feature" });
    expect(sqlValues(call.where)).toContain("feature");
  });

  it("applies widgetId in the generated WHERE clause", async () => {
    const { call } = await whereOf({ widgetId: "7" });
    expect(sqlValues(call.where)).toContain(7);
  });

  it("applies managedProductId as a widget sub-select in the generated WHERE clause", async () => {
    const { call } = await whereOf({ managedProductId: "9" });
    const values = sqlValues(call.where);
    expect(values).toContain(9);
    expect(values).toContain(ORG);
  });

  it("resolves the assigneeId owner filter to a membership id and puts that id in the WHERE clause", async () => {
    const { call, harness } = await whereOf({ assigneeId: "user-owner" });
    expect(harness.membershipFindFirst).toHaveBeenCalledTimes(1);
    expect(sqlValues(call.where)).toContain(42);
  });

  it("filters an assigneeId with no membership to a never-matching id rather than returning everything", async () => {
    const harness = makeListHarness();
    harness.membershipFindFirst.mockResolvedValue(undefined);
    const read = ScopedRead.of(ORG, ACTOR, "all");
    await makeService(harness.db).list(read, parseQuery({ assigneeId: "ghost" }), 42);
    const call = harness.findMany.mock.calls[0]?.[0] as { where?: unknown };
    expect(sqlValues(call.where)).toContain(-1);
  });

  it("applies search as an ILIKE pattern in the generated WHERE clause", async () => {
    const { call } = await whereOf({ search: "crash" });
    expect(sqlValues(call.where)).toContain("%crash%");
  });

  it("does not apply search when it is only whitespace so a stray space is not a filter", async () => {
    const { call } = await whereOf({ search: "   " });
    expect(sqlValues(call.where)).not.toContain("%   %");
  });

  it("applies linked=linked as a linked_ticket_id IS NOT NULL predicate in SQL", async () => {
    const { call } = await whereOf({ linked: "linked" });
    expect(String(call.where)).toBeDefined();
    expect(sqlColumns(call.where)).toContain("linked_ticket_id");
  });

  it("applies linked=unlinked as a linked_ticket_id predicate in SQL", async () => {
    const { call } = await whereOf({ linked: "unlinked" });
    expect(sqlColumns(call.where)).toContain("linked_ticket_id");
  });

  it("omits the linked_ticket_id predicate entirely when the linked filter is absent", async () => {
    const { call } = await whereOf({});
    expect(sqlColumns(call.where)).not.toContain("linked_ticket_id");
  });

  it("applies the from bound as a created_at comparison in SQL", async () => {
    const { call } = await whereOf({ from: "2026-01-01T00:00:00Z" });
    expect(sqlValues(call.where)).toContain("2026-01-01T00:00:00.000Z");
  });

  it("applies the to bound as a created_at comparison in SQL", async () => {
    const { call } = await whereOf({ to: "2026-06-01T00:00:00Z" });
    expect(sqlValues(call.where)).toContain("2026-06-01T00:00:00.000Z");
  });

  it("never loads more than the requested page plus one sentinel row", async () => {
    const { call } = await whereOf({ limit: "25" });
    expect(call.limit).toBe(26);
  });
});

describe("FeedbucketSubmissionsService.list — keyset pagination", () => {
  it("orders by created_at and id so the two-column cursor is a total order", async () => {
    const { call } = await whereOf({});
    expect(Array.isArray(call.orderBy)).toBe(true);
    const ordered = sqlColumns(call.orderBy);
    expect(ordered).toEqual(["created_at", "id"]);
  });

  it("binds the cursor's created_at and id into the WHERE clause, matching the ORDER BY columns", async () => {
    const cursor = encodeCursor({ sortValue: "2026-03-01T10:00:00.000Z", id: "512" });
    const { call } = await whereOf({ cursor });
    const values = sqlValues(call.where);
    expect(values).toContain("2026-03-01T10:00:00.000Z");
    expect(values).toContain(512);
  });

  it("returns no total, page or totalPages on a cursor page so a slice is never presented as the whole set", async () => {
    const cursor = encodeCursor({ sortValue: "2026-03-01T10:00:00.000Z", id: "512" });
    const { result, harness } = await whereOf({ cursor }, [row(9, "2026-02-01T00:00:00Z")]);
    expect(result).not.toHaveProperty("total");
    expect(result).not.toHaveProperty("page");
    expect(result).not.toHaveProperty("totalPages");
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("still reports a real total on the offset page so the legacy paged caller is not regressed", async () => {
    const harness = makeListHarness([row(9, "2026-02-01T00:00:00Z")], 137);
    const read = ScopedRead.of(ORG, ACTOR, "all");
    const result = await makeService(harness.db).list(read, parseQuery({ limit: "20" }), 42);
    expect(result).toMatchObject({ total: 137, page: 1, totalPages: 7 });
  });

  it("reports hasMore and a nextCursor when the sentinel row comes back", async () => {
    const rows = Array.from({ length: 21 }, (_, index) =>
      row(100 - index, `2026-02-0${(index % 9) + 1}T00:00:00Z`),
    );
    const { result } = await whereOf({ limit: "20" }, rows);
    expect(result.data).toHaveLength(20);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
  });

  it("reports hasMore false and a null nextCursor on the last page", async () => {
    const { result } = await whereOf({ limit: "20" }, [row(9, "2026-02-01T00:00:00Z")]);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor with 400 rather than silently serving page one", async () => {
    const harness = makeListHarness();
    const read = ScopedRead.of(ORG, ACTOR, "all");
    await expect(
      makeService(harness.db).list(read, parseQuery({ cursor: "not-a-cursor" }), 42),
    ).rejects.toThrow(BadRequestException);
    expect(harness.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty keyset page with no fabricated total when the caller's scope is none", async () => {
    const harness = makeListHarness();
    const cursor = encodeCursor({ sortValue: "2026-03-01T10:00:00.000Z", id: "512" });
    const read = ScopedRead.of(ORG, ACTOR, "none");
    const result = await makeService(harness.db).list(read, parseQuery({ cursor }), 42);
    expect(result.data).toEqual([]);
    expect(result).not.toHaveProperty("total");
    expect(harness.findMany).not.toHaveBeenCalled();
  });
});
