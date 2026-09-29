import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsCustomersService } from "./projects-customers.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();

interface Captured {
  where: unknown;
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

describe("ProjectsCustomersService.list — search predicate shape (BE-49)", () => {
  it("uses a trailing-wildcard pattern, not a leading wildcard, so the company name column can use a prefix index rather than a full scan", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsCustomersService(buildDb(captured));
    await svc.list("org-1", { limit: 20, search: "acme" });
    const { sql, params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).toContain("ilike");
    const likeParams = params.filter((p): p is string => typeof p === "string" && p.includes("%"));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every((p) => !p.startsWith("%"))).toBe(true);
  });

  it("appends a trailing % so a search for 'acme' finds 'Acme Corp' because the name starts with the term", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsCustomersService(buildDb(captured));
    await svc.list("org-1", { limit: 20, search: "acme" });
    const { params } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    const likeParam = params.find((p): p is string => typeof p === "string" && p.endsWith("%"));
    expect(likeParam).toBe("acme%");
  });

  it("omits the ilike predicate when no search term is given so the full customer catalogue is returned", async () => {
    const captured: Captured = { where: undefined };
    const svc = new ProjectsCustomersService(buildDb(captured));
    await svc.list("org-1", { limit: 20 });
    const { sql } = dialect.sqlToQuery(captured.where as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.toLowerCase()).not.toContain("ilike");
  });
});
