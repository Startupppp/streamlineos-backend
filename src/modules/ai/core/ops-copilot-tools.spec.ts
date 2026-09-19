import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { readCopilotVariantStock, shouldDenyTeamPayrollCopilot, OpsCopilotTools } from "./ops-copilot-tools";
import { SCOPE_ALL_PERMISSION, WarehouseScopeService } from "../../inventory/stock-engine/warehouse-scope.service";
import type { DataScope } from "../../access/access.types";
import type { Db } from "../../../db/drizzle.module";
import type { AskOsActor } from "./services/ask-os-actor";
import type { AskOsToolRunContext } from "./registry/ask-os-tool.types";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
    expect(query.params).toContain("org-1");
    expect(query.sql).toContain("org_id =");
    expect(query.sql).toContain("inv_stock_levels.location_id IN");
    expect(query.sql).toContain("SELECT id FROM inv_locations");
    expect(query.params).toEqual(expect.arrayContaining([7, 9]));
  });

  it("asks nothing at all when the caller is assigned no warehouse", async () => {
    const scope = await scopeServiceFor([], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    const rows = await readCopilotVariantStock(db, "org-1", scope, [11]);

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
    for (const term of ["on_hand", "committed", "blocked_qty", "quality_hold_qty", "outgoing_qty"]) {
      expect(text).toContain(`inv_stock_levels.${term}`);
    }
    expect(text).toContain("is_sellable IS FALSE");
  });

  it("asks nothing when there are no variants to ask about", async () => {
    const scope = await scopeServiceFor([SCOPE_ALL_PERMISSION], []).forUser("org-1", "user-1");
    const { db, executed } = recordingDb();

    expect(await readCopilotVariantStock(db, "org-1", scope, [])).toEqual([]);
    expect(executed).toHaveLength(0);
  });
});

const mockCaller: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const mockActor: AskOsActor = {
  userId: "user-1",
  orgId: "org-1",
  membershipId: 1,
  displayName: "Test User",
  email: "test@example.com",
  orgName: "Test Org",
  role: "member",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

function makeLeaveCtx(scope: DataScope = "own"): AskOsToolRunContext {
  return {
    actor: mockActor,
    caller: mockCaller,
    scope,
    scopes: { "self:leaves": scope },
    modules: {},
  };
}

function buildLeaveOps(dbSelectResult: unknown[] = []) {
  const selectSpy = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(dbSelectResult),
      }),
    }),
  });
  const db = { select: selectSpy } as unknown as Db;
  const ops = new OpsCopilotTools(db, {} as never);
  return { ops, selectSpy };
}

describe("getMyLeaveBalances — self:leaves gate and caller binding", () => {
  it("has permission self:leaves so the registry denies callers without it", () => {
    const { ops } = buildLeaveOps();
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;
    expect(def.permission).toBe("self:leaves");
  });

  it("returns leave balance data for a caller who holds self:leaves", async () => {
    const { ops } = buildLeaveOps([]);
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;
    const result = await def.run({}, makeLeaveCtx("own"));
    expect(result).not.toMatchObject({ kind: "failed" });
    expect(result).toMatchObject({ kind: "data", data: { balances: [] } });
  });

  it("accepts no subject identifier in the tool input — caller identity comes from the run context", () => {
    const { ops } = buildLeaveOps();
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;
    const schema = def.input as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(schema.shape)).toEqual([]);
  });

  it("reports each leave type's real id, because without it the model invents one to apply for leave with", async () => {
    const { ops } = buildLeaveOps([
      { leaveTypeId: 42, leaveTypeName: "Casual Leave", balance: "12.00", daysPerYear: 12 },
    ]);
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;

    const result = await def.run({}, makeLeaveCtx("own"));

    expect(result).toMatchObject({
      kind: "data",
      data: { balances: [{ leaveTypeId: 42, leaveType: "Casual Leave" }] },
    });
  });
});
