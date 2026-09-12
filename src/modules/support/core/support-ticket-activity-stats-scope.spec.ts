import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { ScopedRead } from "../../access/scoped-read";
import { SupportTicketActivityService } from "./support-ticket-activity.service";

const dialect = new PgDialect();
const ORG = "org-support";
const ME = "user-agent";
const SOMEONE_ELSE = "user-other";

function renderWhere(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL)) throw new Error("expected a SQL WHERE clause");
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: query.params };
}

function makeService(rows: unknown[]) {
  const wheres: unknown[] = [];
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
  };
  chain.where = jest.fn((clause: unknown) => {
    wheres.push(clause);
    return chain;
  });
  chain.groupBy = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  const from = jest.fn(() => chain);
  const select = jest.fn(() => ({ from }));
  const db = { select } as unknown as Db;
  return { service: new SupportTicketActivityService(db), wheres, select };
}

describe("SupportTicketActivityService.stats — the aggregate counts only tickets the caller could list", () => {
  it("all scope: every aggregate WHERE carries the tenant predicate", async () => {
    const { service, wheres } = makeService([{ status: "OPEN", cnt: 3 }]);
    await service.stats(ScopedRead.of(ORG, ME, "all"));
    expect(wheres.length).toBeGreaterThan(0);
    for (const clause of wheres) {
      const { sql, params } = renderWhere(clause);
      expect(sql).toContain("org_id");
      expect(params).toContain(ORG);
    }
  });

  it("all scope: no aggregate WHERE binds the actor — an unrestricted reader counts the whole org", async () => {
    const { service, wheres } = makeService([{ status: "OPEN", cnt: 3 }]);
    await service.stats(ScopedRead.of(ORG, ME, "all"));
    for (const clause of wheres) {
      expect(renderWhere(clause).params).not.toContain(ME);
    }
  });

  it("all scope: the counts come straight from the scoped aggregate", async () => {
    const { service } = makeService([{ status: "OPEN", cnt: 3 }]);
    const result = await service.stats(ScopedRead.of(ORG, ME, "all"));
    expect(result.open).toBe(3);
  });

  it("own scope: every aggregate WHERE narrows on the assignee membership and binds the caller", async () => {
    const { service, wheres } = makeService([{ status: "OPEN", cnt: 1 }]);
    await service.stats(ScopedRead.of(ORG, ME, "own"));
    expect(wheres.length).toBeGreaterThan(0);
    for (const clause of wheres) {
      const { sql, params } = renderWhere(clause);
      expect(sql).toContain("assignee_membership_id");
      expect(sql).toContain("organization_members");
      expect(params).toContain(ME);
      expect(params).toContain(ORG);
    }
  });

  it("own scope: the predicate binds the caller, never another agent", async () => {
    const { service, wheres } = makeService([{ status: "OPEN", cnt: 1 }]);
    await service.stats(ScopedRead.of(ORG, ME, "own"));
    for (const clause of wheres) {
      expect(renderWhere(clause).params).not.toContain(SOMEONE_ELSE);
    }
  });

  it("own scope renders a different aggregate WHERE from all scope — the count is narrowed in SQL, not after aggregating", async () => {
    const unrestricted = makeService([{ status: "OPEN", cnt: 1 }]);
    await unrestricted.service.stats(ScopedRead.of(ORG, ME, "all"));
    const owned = makeService([{ status: "OPEN", cnt: 1 }]);
    await owned.service.stats(ScopedRead.of(ORG, ME, "own"));
    expect(renderWhere(owned.wheres[0]).sql).not.toBe(renderWhere(unrestricted.wheres[0]).sql);
  });

  it("none scope: no query is issued at all and every bucket is zero", async () => {
    const { service, wheres, select } = makeService([{ status: "OPEN", cnt: 99 }]);
    const result = await service.stats(ScopedRead.of(ORG, ME, "none"));
    expect(select).not.toHaveBeenCalled();
    expect(wheres).toHaveLength(0);
    expect(result).toEqual({
      open: 0,
      in_progress: 0,
      waiting: 0,
      resolved: 0,
      closed: 0,
      sla_breached: 0,
    });
  });
});
