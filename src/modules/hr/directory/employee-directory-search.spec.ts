process.env.APP_URL ??= "http://localhost:1000";

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { EmployeesService } from "./employees.service";
import { ScopedRead } from "../../access/scoped-read";

const dialect = new PgDialect();

/**
 * HRMS-SEARCH-001. The card shows `users.name` and `users.email`; the search
 * resolver reads `organization_people`. When the resolver missed, the old
 * condition fell back to employee number and designation only, so a name that
 * was on screen returned no rows.
 */
describe("the employee directory search predicate", () => {
  const ORG = "org-1";
  const USER = "user-1";

  function buildService(resolverRows: { id: number }[]) {
    const captured: SQL[] = [];
    const dataChain = {
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const joinChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(),
      where: jest.fn((condition: SQL) => {
        captured.push(condition);
        return dataChain;
      }),
    };
    joinChain["leftJoin"].mockReturnValue(joinChain);

    const db = {
      execute: jest.fn().mockResolvedValue(resolverRows),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue(joinChain),
        }),
      }),
    };
    const cache = {
      cachedVersioned: jest.fn(
        async (_ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
      ),
    };
    const employment = { getFactsBatch: jest.fn().mockResolvedValue(new Map()) };
    const service = new EmployeesService(
      db as never,
      cache as never,
      employment as never,
    );
    return { service, captured, db };
  }

  async function renderedWhere(resolverRows: { id: number }[]) {
    const { service, captured } = buildService(resolverRows);
    await service.listEmployees(ScopedRead.of(ORG, USER, "all"), {
      search: "tarun",
    });
    expect(captured).toHaveLength(1);
    return dialect.sqlToQuery(captured[0]!);
  }

  it.each([
    ["the resolver finds nobody", []],
    ["the resolver finds someone", [{ id: 42 }]],
  ])("matches name and email when %s", async (_case, rows) => {
    const { sql, params } = await renderedWhere(rows);

    expect(sql).toContain(`"users"."name"`);
    expect(sql).toContain(`"users"."email"`);
    expect(sql).toContain(`"users"."first_name"`);
    expect(sql).toContain(`"users"."last_name"`);
    expect(params).toContain("%tarun%");
  });

  it("still narrows to the resolver's ids when it finds some", async () => {
    const { sql, params } = await renderedWhere([{ id: 42 }]);

    expect(sql).toContain(`"hr_people"."id" in`);
    expect(params).toContain(42);
  });

  it("drops the id list above the cap and leans on the indexed columns", async () => {
    const overCap = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    const { sql } = await renderedWhere(overCap);

    expect(sql).not.toContain(`"hr_people"."id" in`);
    expect(sql).toContain(`"users"."name"`);
  });

  it("does not call the resolver when no search term is given", async () => {
    const { service, captured, db } = buildService([]);
    await service.listEmployees(ScopedRead.of(ORG, USER, "all"), {});

    expect(db.execute).not.toHaveBeenCalled();
    expect(dialect.sqlToQuery(captured[0]!).sql).not.toContain(`"users"."name" ilike`);
  });
});
