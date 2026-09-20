import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { listSchema } from "./dto/goal.schemas";
import {
  goalsInManagedProductCondition,
  goalsInPmWorkspaceCondition,
} from "./goals-project-scope";

const dialect = new PgDialect();

function render(cond: SQL): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(cond);
  return { sql: q.sql, params: q.params };
}

describe("listSchema — workspace and product filter fields", () => {
  it("accepts pmWorkspaceId as an optional string filter", () => {
    const result = listSchema.safeParse({ pmWorkspaceId: "ws-abc", page: 1, limit: 20 });
    expect(result.success).toBe(true);
  });

  it("accepts managedProductId as a coerced integer filter", () => {
    const result = listSchema.safeParse({ managedProductId: "7", page: 1, limit: 20 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.managedProductId).toBe(7);
  });

  it("rejects managedProductId of zero (positive() constraint)", () => {
    const result = listSchema.safeParse({ managedProductId: 0, page: 1, limit: 20 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric managedProductId string", () => {
    const result = listSchema.safeParse({ managedProductId: "not-a-number", page: 1, limit: 20 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown filter key so a typo cannot silently widen the read", () => {
    const result = listSchema.safeParse({ pmWorkspaceID: "ws-abc", page: 1, limit: 20 });
    expect(result.success).toBe(false);
  });
});

describe("goalsInPmWorkspaceCondition — the predicate the service actually composes", () => {
  const orgId = "org-tenant-1";
  const pmWorkspaceId = "ws-test-abc";

  it("binds the caller orgId and the requested pmWorkspaceId as positional params", () => {
    const { params } = render(goalsInPmWorkspaceCondition(orgId, pmWorkspaceId));
    expect(params).toContain(orgId);
    expect(params).toContain(pmWorkspaceId);
  });

  it("binds orgId before pmWorkspaceId so the tenant clause can never be dropped from the subquery", () => {
    const { params } = render(goalsInPmWorkspaceCondition(orgId, pmWorkspaceId));
    expect(params.indexOf(orgId)).toBeLessThan(params.indexOf(pmWorkspaceId));
  });

  it("restricts goals through a projected project subquery rather than a correlated per-row read", () => {
    const { sql: text } = render(goalsInPmWorkspaceCondition(orgId, pmWorkspaceId));
    expect(text.toLowerCase()).toContain("in (select");
    expect(text.toLowerCase()).toContain("deleted_at");
  });
});

describe("goalsInManagedProductCondition — the predicate the service actually composes", () => {
  const orgId = "org-tenant-1";
  const managedProductId = 42;

  it("binds the caller orgId and the requested managedProductId as positional params", () => {
    const { params } = render(goalsInManagedProductCondition(orgId, managedProductId));
    expect(params).toContain(orgId);
    expect(params).toContain(managedProductId);
  });

  it("binds orgId before managedProductId so the tenant clause can never be dropped from the subquery", () => {
    const { params } = render(goalsInManagedProductCondition(orgId, managedProductId));
    expect(params.indexOf(orgId)).toBeLessThan(params.indexOf(managedProductId));
  });

  it("excludes soft-deleted projects so an archived product cannot resurrect its goals", () => {
    const { sql: text } = render(goalsInManagedProductCondition(orgId, managedProductId));
    expect(text.toLowerCase()).toContain("deleted_at");
  });
});
