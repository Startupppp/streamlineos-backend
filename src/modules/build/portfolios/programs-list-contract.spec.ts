import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { PgSelectBase, SelectedFields } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { listProgramsQuerySchema } from "./dto/portfolios.schemas";
import { ProgramsService } from "./programs.service";

type AnySelect = PgSelectBase<never, never, never>;

const migration = readFileSync(
  join(__dirname, "..", "..", "..", "..", "migrations", "1178_project_programs_list_indexes.sql"),
  "utf8",
);

function renderListSql(query: Parameters<ProgramsService["listPrograms"]>[1]): Promise<string> {
  const dialect = new PgDialect();
  const qb = new QueryBuilder();
  let rendered = "";
  const db = {
    execute: jest.fn().mockResolvedValue([{ id: 4 }]),
    select: (projection: SelectedFields) => {
      let statement = qb.select(projection) as unknown as AnySelect;
      const chain: Record<string, unknown> = {
        from: (table: unknown) => {
          statement = (statement as unknown as { from(value: unknown): AnySelect }).from(table);
          return chain;
        },
        where: (condition: unknown) => {
          statement = (statement as unknown as { where(value: unknown): AnySelect }).where(condition);
          return chain;
        },
        orderBy: (...columns: unknown[]) => {
          statement = (statement as unknown as { orderBy(...values: unknown[]): AnySelect }).orderBy(...columns);
          return chain;
        },
        limit: (limit: number) => {
          statement = (statement as unknown as { limit(value: number): AnySelect }).limit(limit);
          rendered = dialect.sqlToQuery(statement.getSQL()).sql;
          return Promise.resolve([]);
        },
      };
      return chain;
    },
  } as unknown as Db;

  return new ProgramsService(db, {} as AuditService)
    .listPrograms("org-1", query)
    .then(() => rendered);
}

describe("programs list query contract", () => {
  it("applies bounded defaults", () => {
    expect(listProgramsQuerySchema.parse({})).toEqual({
      limit: 20,
      sort: "createdAt",
      order: "desc",
    });
  });

  it("accepts every supported filter and sort", () => {
    expect(
      listProgramsQuerySchema.parse({
        q: "  launch plan  ",
        ownerId: "user-1",
        health: "at_risk",
        portfolioId: "3",
        status: "active",
        projectId: "9",
        sort: "name",
        order: "asc",
        limit: "100",
      }),
    ).toEqual({
      q: "launch plan",
      ownerId: "user-1",
      health: "at_risk",
      portfolioId: 3,
      status: "active",
      projectId: 9,
      sort: "name",
      order: "asc",
      limit: 100,
    });
  });

  it.each([
    { sort: "health" },
    { order: "sideways" },
    { health: "green" },
    { status: "open" },
    { projectId: "0" },
    { q: "" },
    { unknown: "value" },
  ])("rejects unsupported query input %#", (input) => {
    expect(() => listProgramsQuerySchema.parse(input)).toThrow();
  });
});

describe("programs list database contract", () => {
  it("derives search tenancy from the request transaction and caps the id probe", () => {
    expect(migration).toContain("p.org_id = app.current_org_id()");
    expect(migration).not.toMatch(/search_project_program_ids\s*\(\s*p_org/i);
    expect(migration).toContain("LIMIT LEAST(GREATEST(p_limit, 1), 5001)");
    expect(migration).toContain("SECURITY DEFINER");
  });

  it("backs each sortable page and linked-project filter with a deterministic index", () => {
    expect(migration).toContain("(org_id, created_at DESC, id DESC)");
    expect(migration).toContain("(org_id, updated_at DESC, id DESC)");
    expect(migration).toContain("(org_id, name, id)");
    expect(migration).toContain("(org_id, project_id, program_id)");
    expect(migration).toContain("name gin_trgm_ops");
    expect(migration).toContain("description gin_trgm_ops");
  });
});

describe("ProgramsService.listPrograms filters", () => {
  it("applies every scalar filter and indexed text search in the base tenant", async () => {
    const sql = await renderListSql({
      limit: 25,
      q: "launch",
      ownerId: "user-1",
      health: "at_risk",
      portfolioId: 3,
      status: "active",
      sort: "createdAt",
      order: "desc",
    });
    expect(sql).toContain('"program"."org_id"');
    expect(sql).toContain('"program"."owner_id"');
    expect(sql).toContain('"program"."health"');
    expect(sql).toContain('"program"."portfolio_id"');
    expect(sql).toContain('"program"."status"');
    expect(sql).toContain('"program"."id" in');
    expect(sql).toContain('"program"."deleted_at" is null');
  });

  it("filters by an active linked project inside the same tenant", async () => {
    const sql = await renderListSql({
      limit: 25,
      projectId: 9,
      sort: "createdAt",
      order: "desc",
    });
    expect(sql).toContain('"build"."program_projects"');
    expect(sql).toContain('"build"."projects"');
    expect(sql).toContain("filtered_link.program_id =");
    expect(sql).toContain("filtered_link.org_id =");
    expect(sql).toContain("filtered_project.org_id = filtered_link.org_id");
    expect(sql).toContain("filtered_project.deleted_at IS NULL");
  });
});
