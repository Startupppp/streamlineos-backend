process.env.APP_URL ??= "http://localhost:1000";

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { EmployeesService } from "./employees.service";
import { ScopedRead } from "../../access/scoped-read";

/**
 * V-022 — the directory counter says "Pending invite: 1" while the row beside
 * it badges "Active", because the list payload carried no acceptance signal and
 * no filter could select the pending bucket. The counter and the filter must be
 * the same predicate, or the screen contradicts itself again the next time one
 * of them is edited.
 */
describe("EmployeesService — the pending bucket and the pending filter", () => {
  const ORG = "org-1";
  const USER = "user-1";
  const dialect = new PgDialect();

  const render = (value: SQL) => dialect.sqlToQuery(value).sql;

  function buildDb(rows: unknown[] = []) {
    const captured: { projection?: Record<string, SQL>; where?: SQL } = {};
    const tail = {
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    const chain: Record<string, jest.Mock> = {
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn((where: SQL) => {
        captured.where = where;
        return tail;
      }),
    };
    chain["innerJoin"].mockReturnValue(chain);
    chain["leftJoin"].mockReturnValue(chain);
    const db = {
      select: jest.fn((projection: Record<string, SQL>) => {
        captured.projection = projection;
        return { from: jest.fn().mockReturnValue(chain) };
      }),
    };
    return { db, captured };
  }

  function buildService(db: unknown) {
    const cache = {
      cachedVersioned: jest.fn(
        async (_ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
      ),
    };
    const employment = { getFactsBatch: jest.fn().mockResolvedValue(new Map()) };
    return new EmployeesService(db as never, cache as never, employment as never);
  }

  it("the pending filter returns exactly the people the pending counter counted", async () => {
    const counting = buildDb([{ active: 0, pending: 1, inactive: 0 }]);
    await buildService(counting.db).countEmployees(ScopedRead.of(ORG, USER, "own"), {});
    const counterPending = render(counting.captured.projection!["pending"]!);
    // `count(*) filter (where <predicate>)` — the predicate is what the filter
    // has to reproduce verbatim.
    const predicate = counterPending
      .replace(/^count\(\*\) filter \(where /, "")
      .replace(/\)$/, "");
    expect(predicate).toContain("email_verified");

    const listing = buildDb();
    await buildService(listing.db).listEmployees(ScopedRead.of(ORG, USER, "own"), {
      isActive: "pending",
    });
    expect(render(listing.captured.where!)).toContain(predicate);

    const activeOnly = buildDb();
    await buildService(activeOnly.db).listEmployees(ScopedRead.of(ORG, USER, "own"), {
      isActive: "true",
    });
    expect(render(activeOnly.captured.where!)).not.toContain(predicate);
  });

  it("carries acceptance on every list row so a never-accepted invitee cannot badge as active", async () => {
    const listing = buildDb([
      { id: "u1", cursorName: "a", name: "A", firstName: "A", lastName: null, email: "a@example.test", role: "MEMBER", orgDepartmentId: null, orgDepartmentName: null, image: null, isActive: true, hasAccepted: false },
    ]);
    const page = (await buildService(listing.db).listEmployees(
      ScopedRead.of(ORG, USER, "own"),
      {},
    )) as { data: { isActive: boolean; hasAccepted: boolean }[] };

    expect(listing.captured.projection).toHaveProperty("hasAccepted");
    expect(page.data[0]).toMatchObject({ isActive: true, hasAccepted: false });
  });
});
