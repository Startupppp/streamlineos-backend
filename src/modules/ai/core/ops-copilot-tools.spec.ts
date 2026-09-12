import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readCopilotVariantStock, shouldDenyTeamPayrollCopilot } from "./ops-copilot-tools";
import { SCOPE_ALL_PERMISSION, WarehouseScopeService } from "../../inventory/stock-engine/warehouse-scope.service";
import type { DataScope } from "../../access/access.types";
import type { Db } from "../../../db/drizzle.module";

describe("shouldDenyTeamPayrollCopilot", () => {
  it("denies team scope instead of silently narrowing to self", () => {
    expect(shouldDenyTeamPayrollCopilot("team")).toBe(true);
  });

  it("does not deny own scope", () => {
    expect(shouldDenyTeamPayrollCopilot("own")).toBe(false);
  });

  it("does not deny all scope", () => {
    expect(shouldDenyTeamPayrollCopilot("all")).toBe(false);
  });
});

/**
 * The real scope service, given a fake permission set and a fake assignment
 * table. Using the production class rather than a stand-in is the point: the
 * assertion below is that the copilot binds *that* predicate, so a stub of it
 * would prove nothing.
 */
function scopeServiceFor(permissions: string[], assignedWarehouseIds: number[]) {
  const perms = new Map<string, DataScope>(permissions.map((key) => [key, "all"]));
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(assignedWarehouseIds.map((warehouseId) => ({ warehouseId }))),
      }),
    }),
  };
  const access = { resolveUserPermissions: () => Promise.resolve(perms) };
  return new WarehouseScopeService(db as never, access as never);
}

/** A `Db` that records the statements handed to `execute` and returns nothing. */
function recordingDb() {
  const executed: SQL[] = [];
  const db = {
    execute: (statement: SQL) => {
      executed.push(statement);
      return Promise.resolve([]);
    },
  };
  return { db: db as unknown as Db, executed };
}

function render(statement: SQL) {
  return new PgDialect().sqlToQuery(statement);
}

describe("F2 — the copilot's stock read is access-scoped in SQL", () => {
  it("binds the tenant and the warehouse assignment into the predicate, not the prompt", async () => {
    const scope = await scopeServiceFor([], [7, 9]).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    await readCopilotVariantStock(db, "org-1", scope, [11, 12]);

    expect(executed).toHaveLength(1);
    const query = render(executed[0] as SQL);
    // The asker's org is a bound parameter of the statement, not an instruction
    // the model is trusted to respect.
    expect(query.params).toContain("org-1");
    expect(query.sql).toContain("org_id =");
    // And the warehouse gate is the scope service's own subquery, on the
    // location column, with the assigned ids bound.
    expect(query.sql).toContain("inv_stock_levels.location_id IN");
    expect(query.sql).toContain("SELECT id FROM inv_locations");
    expect(query.params).toEqual(expect.arrayContaining([7, 9]));
  });

  it("asks nothing at all when the caller is assigned no warehouse", async () => {
    const scope = await scopeServiceFor([], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    const rows = await readCopilotVariantStock(db, "org-1", scope, [11]);

    // Deny by default: no assignment means no stock, and it costs no query.
    expect(rows).toEqual([]);
    expect(executed).toHaveLength(0);
  });

  it("applies no warehouse predicate for a caller holding the org-wide scope key", async () => {
    const scope = await scopeServiceFor([SCOPE_ALL_PERMISSION], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    await readCopilotVariantStock(db, "org-1", scope, [11]);

    const query = render(executed[0] as SQL);
    expect(query.sql).not.toContain("SELECT id FROM inv_locations");
    expect(query.sql).toContain("org_id =");
  });

  it("computes available from the shared expression, with every term and the transit gate", async () => {
    const scope = await scopeServiceFor([SCOPE_ALL_PERMISSION], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    await readCopilotVariantStock(db, "org-1", scope, [11]);

    const { sql: text } = render(executed[0] as SQL);
    // A1's five terms — this read once subtracted only the first two.
    for (const term of ["on_hand", "committed", "blocked_qty", "quality_hold_qty", "outgoing_qty"]) {
      expect(text).toContain(`inv_stock_levels.${term}`);
    }
    // A2's gate: stock standing at a non-sellable location is not available.
    expect(text).toContain("is_sellable IS FALSE");
  });

  it("asks nothing when there are no variants to ask about", async () => {
    const scope = await scopeServiceFor([SCOPE_ALL_PERMISSION], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    expect(await readCopilotVariantStock(db, "org-1", scope, [])).toEqual([]);
    expect(executed).toHaveLength(0);
  });
});
