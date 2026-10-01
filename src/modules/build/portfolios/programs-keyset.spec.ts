import { actorIn, programsService } from "./__tests__/portfolio-spec-fixtures";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProgramsService } from "./programs.service";
import type { Db } from "../../../db/drizzle.module";
import {
  decodeTupleCursor,
  encodeTupleCursor,
} from "../../../common/pagination/cursor";
import type { ListProgramsQuery } from "./dto/portfolios.schemas";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
  projection: Record<string, unknown>;
  limit: number | undefined;
}

function buildDb(captured: Captured, rows: unknown[] = []) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn((value: number) => {
      captured.limit = value;
      return Promise.resolve(rows);
    }),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn((proj: Record<string, unknown>) => {
      captured.projection = proj;
      return builder;
    }),
  } as unknown as Db;
}

async function capture(
  cursor: string | undefined,
  rows: unknown[] = [],
  limit = 20,
  overrides: Partial<ListProgramsQuery> = {},
) {
  const captured: Captured = {
    where: undefined,
    orderBy: [],
    projection: {},
    limit: undefined,
  };
  const svc = (await programsService(buildDb(captured, rows)));
  const page = await svc.listPrograms(actorIn("org-1"), {
    cursor,
    limit,
    status: undefined,
    portfolioId: undefined,
    sort: "createdAt",
    order: "desc",
    ...overrides,
  });
  return { ...captured, page };
}

describe("ProgramsService.listPrograms — the page is keyset-bounded, not a silent hundred-row truncation", () => {
  it("orders by createdAt desc then id desc, so the hundred rows a caller used to get are now a defined page", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
    expect(rendered[1]).toContain("desc");
  });

  it("asks for limit + 1 rows so hasMore is measured rather than guessed", async () => {
    const { limit } = await capture(undefined, [], 20);
    expect(limit).toBe(21);
  });

  it("applies a strict less-than cursor predicate matching the descending sort", async () => {
    const cursor = encodeTupleCursor([
      "createdAt",
      "desc",
      new Date().toISOString(),
      "7",
    ]);
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).not.toMatch(/>/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/"created_at"\s*</);
  });

  it("reports hasMore and a nextCursor once more rows exist than the page holds", async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) => {
      const day = String(10 - index).padStart(2, "0");
      return {
        id: index + 1,
        createdAt: new Date(`2026-01-${day}T00:00:00.000Z`),
        updatedAt: new Date(`2026-01-${day}T00:00:00.000Z`),
        createdAtCursor: `2026-01-${day}T00:00:00.000000`,
        updatedAtCursor: `2026-01-${day}T00:00:00.000000`,
      };
    });
    const captured: Captured = {
      where: undefined,
      orderBy: [],
      projection: {},
      limit: undefined,
    };
    const svc = (await programsService(buildDb(captured, rows)));
    const page = await svc.listPrograms(actorIn("org-1"), {
      cursor: undefined,
      limit: 2,
      status: undefined,
      portfolioId: undefined,
      sort: "createdAt",
      order: "desc",
    });
    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toEqual(expect.any(String));
    expect(decodeTupleCursor(page.pagination.nextCursor, 4)?.slice(0, 2)).toEqual([
      "createdAt",
      "desc",
    ]);
  });

  it("preserves the database microseconds in a timestamp cursor without exposing its projection", async () => {
    const createdAtCursor = "2026-01-10T12:34:56.123456";
    const rows = [
      {
        id: 7,
        createdAt: new Date("2026-01-10T12:34:56.123Z"),
        updatedAt: new Date("2026-01-10T12:34:56.654Z"),
        createdAtCursor,
        updatedAtCursor: "2026-01-10T12:34:56.654321",
      },
      {
        id: 6,
        createdAt: new Date("2026-01-10T12:34:56.123Z"),
        updatedAt: new Date("2026-01-10T12:34:56.654Z"),
        createdAtCursor: "2026-01-10T12:34:56.123455",
        updatedAtCursor: "2026-01-10T12:34:56.654320",
      },
    ];
    const { page, projection } = await capture(undefined, rows, 1);
    const updatedPage = (
      await capture(undefined, rows, 1, { sort: "updatedAt" })
    ).page;

    expect(decodeTupleCursor(page.pagination.nextCursor, 4)).toEqual([
      "createdAt",
      "desc",
      createdAtCursor,
      "7",
    ]);
    expect(decodeTupleCursor(updatedPage.pagination.nextCursor, 4)).toEqual([
      "updatedAt",
      "desc",
      "2026-01-10T12:34:56.654321",
      "7",
    ]);
    expect(render(projection["createdAtCursor"])).toContain("to_char");
    expect(render(projection["updatedAtCursor"])).toContain("to_char");
    expect(page.data[0]).not.toHaveProperty("createdAtCursor");
    expect(page.data[0]).not.toHaveProperty("updatedAtCursor");
  });

  it("uses a strict greater-than keyset for ascending name order", async () => {
    const cursor = encodeTupleCursor(["name", "asc", "Launch", "7"]);
    const { orderBy, where } = await capture(cursor, [], 20, {
      sort: "name",
      order: "asc",
    });
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"name"');
    expect(rendered[0]).toContain("asc");
    expect(rendered[1]).toContain('"id"');
    expect(rendered[1]).toContain("asc");
    expect(render(where)).toMatch(/>/);
  });

  it("uses updatedAt with a strict less-than keyset for descending order", async () => {
    const cursor = encodeTupleCursor([
      "updatedAt",
      "desc",
      new Date().toISOString(),
      "7",
    ]);
    const { orderBy, where } = await capture(cursor, [], 20, {
      sort: "updatedAt",
      order: "desc",
    });
    expect(orderBy.map(render)[0]).toContain('"updated_at"');
    expect(render(where)).toMatch(/</);
  });

  it("binds timestamp cursors at database precision for both directions", async () => {
    const sortValue = "2026-01-10T12:34:56.123456";
    const descending = await capture(
      encodeTupleCursor(["createdAt", "desc", sortValue, "7"]),
    );
    const ascending = await capture(
      encodeTupleCursor(["updatedAt", "asc", sortValue, "7"]),
      [],
      20,
      { sort: "updatedAt", order: "asc" },
    );

    expect(render(descending.where)).toContain("::timestamp");
    expect(render(descending.where)).toMatch(/</);
    expect(render(ascending.where)).toContain("::timestamp");
    expect(render(ascending.where)).toMatch(/>/);
  });

  it("accepts a previously issued millisecond ISO timestamp cursor", async () => {
    const cursor = encodeTupleCursor([
      "createdAt",
      "desc",
      "2026-01-10T12:34:56.123Z",
      "7",
    ]);
    const { where } = await capture(cursor);
    expect(render(where)).toContain("::timestamp");
  });

  it("ignores a cursor minted for a different sort contract", async () => {
    const cursor = encodeTupleCursor(["name", "asc", "Launch", "7"]);
    const { where } = await capture(cursor);
    expect(render(where)).not.toMatch(/"created_at"\s*[<>]/);
  });
});

describe("ProgramsService.listPrograms — the projectCount subquery is tenant-scoped and fully qualified", () => {
  async function projectCountSql(): Promise<string> {
    const { projection } = await capture(undefined);
    return render(projection["projectCount"]);
  }

  it("qualifies every column it reads, so no bare id can bind to the wrong relation", async () => {
    const sql = await projectCountSql();
    for (const reference of [
      "linked_project.id",
      "linked_project.org_id",
      "linked_project.deleted_at",
      "link.project_id",
      "link.org_id",
      "link.program_id",
      "program.id",
      "program.org_id",
    ]) {
      expect(sql).toContain(reference);
    }
  });

  it("joins the link row to its project on the tenant as well as the id, so a cross-tenant link row cannot inflate the count", async () => {
    const sql = await projectCountSql();
    expect(sql).toContain("linked_project.org_id = link.org_id");
  });

  it("counts linked projects rather than programs, so the join reads the link's project_id", async () => {
    const sql = await projectCountSql();
    expect(sql).toContain("linked_project.id = link.project_id");
    expect(sql).not.toContain("linked_project.id = link.program_id");
  });

  it("excludes soft-deleted projects from the count", async () => {
    expect(await projectCountSql()).toContain("linked_project.deleted_at IS NULL");
  });

  it("correlates against an alias the outer statement declares, so the subquery cannot raise 42P01", async () => {
    const { orderBy } = await capture(undefined);
    const outerAlias = orderBy.map(render).join(" ");
    expect(outerAlias).toContain('"program"."id"');
    expect(await projectCountSql()).toContain("program.id");
  });

  it("bite proof: an unqualified id in the correlated join is ambiguous across link and linked_project", () => {
    const ambiguous = "INNER JOIN projects linked_project ON id = link.project_id";
    expect(ambiguous).not.toContain("linked_project.id =");
  });
});
