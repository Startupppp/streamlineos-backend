import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { InvPhysicalAuditsService } from "../inv-physical-audits.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * `listAudits` was scoped and everything reachable by id was not.
 *
 * The same shape as the cycle counts beside it, and the same file: the list
 * resolves the caller's warehouses through `scope.warehouse(...)`, while the
 * detail read and every mutation behind it took no caller id at all. A
 * wall-to-wall audit is the entire stock position of a building line by line,
 * and posting one writes those variances against the real books — so an auditor
 * scoped to one warehouse could read, advance, rewrite, post or cancel the
 * count of another.
 *
 * THE PREDICATE IS THE ASSERTION, NOT THE THROW: a fixture that answers empty
 * whatever the WHERE says makes "rejects with NotFoundException" pass against
 * the unscoped code too.
 */

const ORG = "org-1";
const USER = "auditor-1";
const ID = 42;

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

function sqlParams(statement: SQL): unknown[] {
  // Through the dialect, never `queryChunks` — and never `JSON.stringify` on a
  // Drizzle SQL object, which throws on the circular reference to its table.
  return new PgDialect().sqlToQuery(statement).params;
}

/** Every `findFirst` WHERE, in order. `wheres[0]` is always the gated read. */
function auditsDb(row: unknown) {
  const wheres: SQL[] = [];
  const findFirst = jest.fn((args: { where: SQL }) => {
    wheres.push(args.where);
    return Promise.resolve(row);
  });
  const tx = {
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  };
  const db = {
    query: {
      invPhysicalAudits: { findFirst },
      invPhysicalAuditLines: { findMany: jest.fn(() => Promise.resolve([])) },
    },
    update: jest.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
    execute: jest.fn(() => Promise.resolve([])),
    transaction: jest.fn((run: (t: unknown) => Promise<unknown>) => run(tx)),
  };
  return { db, wheres };
}

/** A scope service answering with exactly these warehouses, or org-wide for `null`. */
function scopeOf(warehouseIds: number[] | null) {
  const consulted = jest.fn(() =>
    Promise.resolve(new Set(warehouseIds === null ? ["inventory:warehouses:scope-all"] : [])),
  );
  const service = new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve((warehouseIds ?? []).map((warehouseId) => ({ warehouseId }))),
        }),
      }),
    } as never,
    { resolveUserPermissions: consulted } as never,
  );
  return { service, consulted };
}

function serviceWith(db: unknown, scope: WarehouseScopeService): InvPhysicalAuditsService {
  const cache = { invalidate: jest.fn(), invalidateNamespace: jest.fn() };
  // (db, cache, engine, numSeq, warehouseScope) — the scope is LAST here and
  // third in the cycle-counts service. The two constructors are not swappable.
  return new InvPhysicalAuditsService(db as never, cache as never, {} as never, {} as never, scope);
}

interface Reachable {
  name: string;
  /** The status the gate has to read back for this method to get past it. */
  status: string;
  invoke: (service: InvPhysicalAuditsService) => Promise<unknown>;
}

const REACHABLE: Reachable[] = [
  { name: "getAudit", status: "PLANNED", invoke: (s) => s.getAudit(ORG, USER, ID) },
  { name: "startAudit", status: "PLANNED", invoke: (s) => s.startAudit(ORG, USER, ID) },
  {
    name: "updateLines",
    status: "COUNTING",
    invoke: (s) => s.updateLines(ORG, USER, ID, { lines: [{ lineId: 1, countedQty: 5 }] }),
  },
  { name: "reviewAudit", status: "COUNTING", invoke: (s) => s.reviewAudit(ORG, USER, ID) },
  { name: "postAudit", status: "REVIEW", invoke: (s) => s.postAudit(ORG, USER, ID, "idem-1") },
  { name: "cancelAudit", status: "PLANNED", invoke: (s) => s.cancelAudit(ORG, USER, ID) },
];

const rowWith = (status: string) => ({
  id: ID,
  status,
  auditNumber: "PA-0001",
  warehouseId: 7,
  lines: [],
});

describe("one physical audit, reached by id", () => {
  it.each(REACHABLE)(
    "$name narrows a scoped caller to their own warehouses",
    async ({ status, invoke }) => {
      const { db, wheres } = auditsDb(rowWith(status));
      const service = serviceWith(db, scopeOf([7, 9]).service);

      await invoke(service);

      expect(sqlText(wheres[0] as SQL)).toContain(
        '"inv_physical_audits"."warehouse_id" IN ($3, $4)',
      );
      expect(sqlParams(wheres[0] as SQL)).toEqual([ORG, ID, 7, 9]);
    },
  );

  it.each(REACHABLE)(
    "$name makes the audit unreachable for a caller with no warehouse, and answers not found",
    async ({ invoke }) => {
      const { db, wheres } = auditsDb(undefined);
      const service = serviceWith(db, scopeOf([]).service);

      await expect(invoke(service)).rejects.toBeInstanceOf(NotFoundException);
      // `FALSE` is what `listAudits` compiles an empty scope to and what a real
      // database would act on; the throw on its own would be vacuous here. The
      // 404 rather than 403 is pinned in the same case so it cannot pass alone.
      expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
    },
  );

  it.each(REACHABLE)(
    "$name leaves an org-wide reader exactly as wide as they were",
    async ({ status, invoke }) => {
      const { db, wheres } = auditsDb(rowWith(status));
      const { service: scope, consulted } = scopeOf(null);
      const service = serviceWith(db, scope);

      await invoke(service);

      expect(consulted).toHaveBeenCalledWith(ORG, USER);
      expect(sqlText(wheres[0] as SQL)).not.toContain('"warehouse_id"');
    },
  );
});

describe("the audit a caller has just created", () => {
  it("is read back through a named unscoped method, not a flag on the public one", () => {
    const source = readFileSync(join(__dirname, "..", "inv-physical-audits.service.ts"), "utf8");
    expect(source).toContain("private async loadAuditUnscoped(");
    expect(source).toMatch(/async getAudit\([^)]*userId: string[^)]*\)/);

    /*
     * The six commands moved to `lib/physical-audit-commands.ts`, and the
     * boundary did NOT move with them: they reach the ungated read through a
     * closure the service binds, so nothing under `counts/lib/` calls it.
     * Asserted rather than trusted — the obvious way to do that split, exporting
     * `loadAuditUnscoped` from the lib, is exactly what naming it private was
     * for. The check is on `loadAuditUnscoped(` with the paren, so a lib may
     * still name it in a comment explaining why it takes a callback.
     */
    const libDir = join(__dirname, "..", "lib");
    for (const file of readdirSync(libDir)) {
      const text = readFileSync(join(libDir, file), "utf8");
      expect({ file, callsUngatedRead: text.includes("loadAuditUnscoped(") }).toEqual({
        file,
        callsUngatedRead: false,
      });
    }
    const commands = readFileSync(join(libDir, "physical-audit-commands.ts"), "utf8");
    expect(commands).toContain("return deps.reloadUnscopedAudit(orgId, audit.id);");
    expect(source).toContain(
      "reloadUnscopedAudit: (orgId, auditId) => this.loadAuditUnscoped(orgId, auditId)",
    );
  });

  it("refuses to open an audit of a warehouse the caller does not hold", async () => {
    const { db } = auditsDb(undefined);
    const service = serviceWith(db, scopeOf([9]).service);

    await expect(service.createAudit(ORG, USER, { warehouseId: 7 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
