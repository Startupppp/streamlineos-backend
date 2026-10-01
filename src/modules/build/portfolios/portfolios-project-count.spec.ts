import { actorIn, portfoliosService, programsService } from "./__tests__/portfolio-spec-fixtures";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { PgSelectBase, SelectedFields } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { PortfoliosService } from "./portfolios.service";
import { ProgramsService } from "./programs.service";
import { listProgramsQuerySchema } from "./dto/portfolios.schemas";

type AnySelect = PgSelectBase<never, never, never>;

interface RenderedDb {
  readonly db: Db;
  render(): string;
}

const PROGRAM_LIST_QUERY = listProgramsQuerySchema.parse({});

function renderingDb(): RenderedDb {
  const dialect = new PgDialect();
  const qb = new QueryBuilder();
  let rendered = "";
  const db = {
    select: (projection: SelectedFields) => {
      let q = qb.select(projection) as unknown as AnySelect;
      const chain: Record<string, unknown> = {
        from: (table: unknown) => {
          q = (q as unknown as { from(t: unknown): AnySelect }).from(table);
          return chain;
        },
        where: (condition: unknown) => {
          q = (q as unknown as { where(c: unknown): AnySelect }).where(condition);
          return chain;
        },
        orderBy: (...columns: unknown[]) => {
          q = (q as unknown as { orderBy(...c: unknown[]): AnySelect }).orderBy(...columns);
          return chain;
        },
        limit: (n: number) => {
          q = (q as unknown as { limit(n: number): AnySelect }).limit(n);
          rendered = dialect.sqlToQuery(q.getSQL()).sql;
          return Promise.resolve([]);
        },
      };
      return chain;
    },
  } as unknown as Db;
  return { db, render: () => rendered };
}

it("counts portfolio projects from a relation that exists in the statement", async () => {
  const { db, render } = renderingDb();

  await (await portfoliosService(db)).listPortfolios(actorIn("org-1"), { limit: 20 });

  const sql = render();
  expect(sql).toContain('"build"."portfolio_projects"');
  expect(sql).not.toMatch(/from\s+"portfolio_project"/i);
  expect(sql).not.toMatch(/join\s+"portfolio_linked_project"/i);
});

it("correlates the portfolio project count to the outer portfolio row", async () => {
  const { db, render } = renderingDb();

  await (await portfoliosService(db)).listPortfolios(actorIn("org-1"), { limit: 20 });

  const sql = render();
  expect(sql).toMatch(/portfolio_id\s*=\s*"?portfolio"?\."?id"?/);
  expect(sql).toMatch(/org_id\s*=\s*"?portfolio"?\."?org_id"?/);
  expect(sql).not.toMatch(/"portfolio_id"\s*=\s*"id"/);
  expect(sql).not.toMatch(/"org_id"\s*=\s*"org_id"/);
});

it("counts program projects from a relation that exists in the statement", async () => {
  const { db, render } = renderingDb();

  await (await programsService(db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  const sql = render();
  expect(sql).toContain('"build"."program_projects"');
  expect(sql).not.toMatch(/from\s+"program_project"/i);
  expect(sql).not.toMatch(/join\s+"program_linked_project"/i);
});

it("correlates the program project count to the outer program row", async () => {
  const { db, render } = renderingDb();

  await (await programsService(db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  const sql = render();
  expect(sql).toMatch(/program_id\s*=\s*"?program"?\."?id"?/);
  expect(sql).toMatch(/org_id\s*=\s*"?program"?\."?org_id"?/);
  expect(sql).not.toMatch(/"program_id"\s*=\s*"id"/);
  expect(sql).not.toMatch(/"org_id"\s*=\s*"org_id"/);
});

it("declares the outer portfolio alias that the project count correlates against", async () => {
  const { db, render } = renderingDb();

  await (await portfoliosService(db)).listPortfolios(actorIn("org-1"), { limit: 20 });

  expect(render()).toMatch(/"project_portfolios"\s+"portfolio"/);
});

it("declares the outer program alias that the project count correlates against", async () => {
  const { db, render } = renderingDb();

  await (await programsService(db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  expect(render()).toMatch(/"project_programs"\s+"program"/);
});

it("joins the schema-qualified projects relation when counting portfolio projects", async () => {
  const { db, render } = renderingDb();

  await (await portfoliosService(db)).listPortfolios(actorIn("org-1"), { limit: 20 });

  expect(render()).toContain('"build"."projects"');
});

it("joins the schema-qualified projects relation when counting program projects", async () => {
  const { db, render } = renderingDb();

  await (await programsService(db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  expect(render()).toContain('"build"."projects"');
});

it("qualifies both portfolio correlation columns with their own relation", async () => {
  const { db, render } = renderingDb();

  await (await portfoliosService(db)).listPortfolios(actorIn("org-1"), { limit: 20 });

  const sql = render();
  expect(sql).toContain("link.portfolio_id = portfolio.id");
  expect(sql).toContain("link.org_id = portfolio.org_id");
  expect(sql).not.toContain("link.org_id = link.org_id");
});

it("qualifies both program correlation columns with their own relation", async () => {
  const { db, render } = renderingDb();

  await (await programsService(db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  const sql = render();
  expect(sql).toContain("link.program_id = program.id");
  expect(sql).toContain("link.org_id = program.org_id");
  expect(sql).not.toContain("link.org_id = link.org_id");
});

it("keeps the soft-delete fence qualified in both project count subqueries", async () => {
  const portfolios = renderingDb();
  const programs = renderingDb();

  await (await portfoliosService(portfolios.db)).listPortfolios(actorIn("org-1"), {
    limit: 20,
  });
  await (await programsService(programs.db)).listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);

  for (const sql of [portfolios.render(), programs.render()]) {
    expect(sql).toContain("linked_project.id = link.project_id");
    expect(sql).toContain("linked_project.deleted_at IS NULL");
    expect(sql).not.toMatch(/\bAND\s+"deleted_at"\s+IS\s+NULL/);
  }
});
