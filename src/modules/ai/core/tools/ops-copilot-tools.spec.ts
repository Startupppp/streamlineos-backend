import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { OpsCopilotTools } from "./ops-copilot-tools";
import { readCopilotVariantStock } from "./lib/ops-copilot-reads";
import { VARIANT_SCAN_CAP } from "./lib/tool-read-caps";
import { SCOPE_ALL_PERMISSION, WarehouseScopeService } from "../../../inventory/stock-engine/warehouse-scope.service";
import type { DataScope } from "../../../access/access.types";
import type { Db } from "../../../../db/drizzle.module";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

describe("every ops-copilot read stays inside the 100-row page cap", () => {
  it("keeps VARIANT_SCAN_CAP at or under 100, because an unbounded variant scan bills every token against the model on every inventory lookup", () => {
    expect(VARIANT_SCAN_CAP).toBeLessThanOrEqual(100);
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

function recordingDb(rows: Record<string, unknown>[] = []) {
  const executed: SQL[] = [];
  const db = {
    execute: (statement: SQL) => {
      executed.push(statement);
      return Promise.resolve(rows);
    },
  };
  return { db: db as unknown as Db, executed };
}

function render(statement: SQL) {
  return new PgDialect().sqlToQuery(statement);
}

function renderOnly(statements: readonly SQL[]) {
  const [first] = statements;
  if (first === undefined) throw new Error("no statement reached the database");
  return render(first);
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
  const read = ScopedRead.of(mockActor.orgId, mockActor.userId, scope);
  return {
    actor: mockActor,
    caller: mockCaller,
    read,
    readFor: (key) => (key === "self:leaves" ? read : ScopedRead.of(mockActor.orgId, mockActor.userId, "none")),
    modules: {},
  };
}

function buildLeaveOps(dbSelectResult: unknown[] = []) {
  const selectSpy = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(dbSelectResult),
        }),
      }),
    }),
  });
  const db = { select: selectSpy } as unknown as Db;
  const ops = new OpsCopilotTools(db, {} as never);
  return { ops, selectSpy };
}

function opsToolNamed(ops: OpsCopilotTools, key: string): AskOsToolDefinition {
  const found = ops.tools().find((definition) => definition.key === key);
  if (found === undefined) throw new Error(`OpsCopilotTools declares no tool named "${key}"`);
  return found;
}

function ctxFor(
  definition: AskOsToolDefinition,
  scopes: Readonly<Record<string, DataScope>>,
): AskOsToolRunContext {
  const readFor = (key: string) =>
    ScopedRead.of(mockActor.orgId, mockActor.userId, scopes[key] ?? "none");
  return {
    actor: mockActor,
    caller: mockCaller,
    read:
      definition.permission === undefined
        ? ScopedRead.of(mockActor.orgId, mockActor.userId, "all")
        : readFor(definition.permission),
    readFor,
    modules: { payroll: true },
  };
}

describe("R-8 — a payroll tool's declared permission names the widest figures it can return", () => {
  it("declares hr:payroll:view on the tool that can return org-wide payroll totals, because that is the key which actually governs them", () => {
    const { db } = recordingDb();

    expect(opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary").permission).toBe(
      "hr:payroll:view",
    );
  });

  it("declares self:payslips on no ops tool, because self:payslips resolves to own for every member and so can never describe an org aggregate", () => {
    const { db } = recordingDb();
    const ops = new OpsCopilotTools(db, {} as never);

    const selfDeclared = ops
      .tools()
      .filter((definition) => definition.permission === "self:payslips")
      .map((definition) => definition.key);

    expect(selfDeclared).toEqual([]);
  });

  it("offers no tool whose returned authority changes with the caller's scope, so the registry's own availability gate describes the tool", () => {
    const { db } = recordingDb();
    const ops = new OpsCopilotTools(db, {} as never);

    expect(ops.tools().map((definition) => definition.key)).not.toContain("getPayrollSummary");
  });
});

describe("getOrgPayrollSummary — the runtime scope gate still bites", () => {
  it("gives an own-scoped caller only their own figures by refusing the org aggregate and issuing no query at all", async () => {
    const { db, executed } = recordingDb([{ status: "PAID", count: "9", total_net: "99999.00" }]);
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    const result = await definition.run(
      {},
      ctxFor(definition, { "hr:payroll:view": "own", "self:payslips": "own" }),
    );

    expect(result).toMatchObject({ kind: "denied", permission: "hr:payroll:view" });
    expect(executed).toEqual([]);
  });

  it("denies team scope rather than silently narrowing it, so the model reports a restriction and not an absence", async () => {
    const { db, executed } = recordingDb([{ status: "PAID", count: "9", total_net: "99999.00" }]);
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    const result = await definition.run({}, ctxFor(definition, { "hr:payroll:view": "team" }));

    expect(result).toMatchObject({ kind: "denied", permission: "hr:payroll:view" });
    expect(result).not.toMatchObject({ kind: "empty" });
    expect(executed).toEqual([]);
  });

  it("holding self:payslips at own does not unlock the org aggregate, which is the widening the old single tool allowed", async () => {
    const { db, executed } = recordingDb([{ status: "PAID", count: "9", total_net: "99999.00" }]);
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    const result = await definition.run(
      {},
      ctxFor(definition, { "self:payslips": "all", "hr:payroll:view": "none" }),
    );

    expect(result).toMatchObject({ kind: "denied", permission: "hr:payroll:view" });
    expect(executed).toEqual([]);
  });

  it("answers the org aggregate only for a caller whose hr:payroll:view scope is all", async () => {
    const { db, executed } = recordingDb([{ status: "PAID", count: "3", total_net: "900.50" }]);
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    const result = await definition.run({}, ctxFor(definition, { "hr:payroll:view": "all" }));

    expect(result).toMatchObject({
      kind: "data",
      data: { scope: "organization", byStatus: [{ status: "PAID", count: 3, totalNet: 900.5 }] },
    });
    expect(executed).toHaveLength(1);
  });

  it("binds the actor's own org and the requested month as parameters, never an org the model named", async () => {
    const { db, executed } = recordingDb();
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    await definition.run({ month: "2026-03" }, ctxFor(definition, { "hr:payroll:view": "all" }));

    const query = renderOnly(executed);
    expect(query.params).toContain("org-1");
    expect(query.params).toContain("2026-03");
    expect(query.sql).toContain("pr.org_id =");
  });

  it("accepts no subject identifier in its input, so the org aggregate cannot be re-aimed at one named person", () => {
    const { db } = recordingDb();
    const definition = opsToolNamed(new OpsCopilotTools(db, {} as never), "getOrgPayrollSummary");

    expect(definition.input.parse({ month: "2026-03", userId: "victim", orgId: "org-2" })).toEqual({
      month: "2026-03",
    });
  });
});

describe("getMyLeaveBalances — actor.currentYear used, not server wall-clock", () => {
  it("returns the actor year in the response, not the server clock year, so a future-timezone user sees their year", async () => {
    const { ops } = buildLeaveOps([
      { leaveTypeId: 1, leaveTypeName: "Annual Leave", balance: "10.00", daysPerYear: 20 },
    ]);
    const actorIn2027 = { ...mockActor, currentYear: 2027 };
    const ctx: AskOsToolRunContext = {
      actor: actorIn2027,
      caller: mockCaller,
      read: ScopedRead.of(actorIn2027.orgId, actorIn2027.userId, "own"),
      readFor: (key) =>
        key === "self:leaves"
          ? ScopedRead.of(actorIn2027.orgId, actorIn2027.userId, "own")
          : ScopedRead.of(actorIn2027.orgId, actorIn2027.userId, "none"),
      modules: {},
    };
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;

    const result = await def.run({}, ctx);

    expect(result).toMatchObject({ kind: "data", data: { year: 2027 } });
  });
});

describe("getMyLeaveBalances — self:leaves gate and caller binding", () => {
  it("has permission self:leaves so the registry denies callers without it", () => {
    const { ops } = buildLeaveOps();
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;
    expect(def.permission).toBe("self:leaves");
  });

  it("reports no balances as empty, not as data with a prose message the model must parse", async () => {
    const { ops } = buildLeaveOps([]);
    const def = ops.tools().find((d) => d.key === "getMyLeaveBalances")!;
    const result = await def.run({}, makeLeaveCtx("own"));
    expect(result).not.toMatchObject({ kind: "failed" });
    expect(result).toMatchObject({ kind: "empty", subject: "leave balances" });
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
