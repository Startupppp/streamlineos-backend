import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { QuickCommerceInboundService } from "../quick-commerce-inbound.service";
import { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";

/**
 * `listAsns` was scoped and `asnDetail` was not.
 *
 * The list resolves the caller's warehouses and gates on them; the detail took
 * no `userId` at all — the controller never passed one — so it answered on
 * `org_id` and the row id alone. Whoever could not see an ASN in the list could
 * still read it whole, header and every line, by id.
 *
 * Second instance of this shape in inventory in one pass; the labour records
 * drill-down behind the labour board was the first. An aggregate that narrows
 * and a detail that does not is evidently the way this gets written, so both are
 * pinned.
 */

function chainDb(rows: readonly (readonly unknown[])[]) {
  const wheres: SQL[] = [];
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "orderBy", "limit", "offset"]) chain[method] = () => chain;
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(rows[call++] ?? []).then(resolve, reject);
  return { db: chain as never, wheres };
}

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

function serviceWith(db: unknown, scope: WarehouseScopeService): QuickCommerceInboundService {
  const stub = {} as never;
  return new QuickCommerceInboundService(db as never, stub, stub, stub, stub, scope, stub);
}

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

describe("one ASN, read by id", () => {
  it("makes the row unreachable for a caller with no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw.
     *
     * My first version asserted only that this rejects with NotFoundException,
     * and it passed against the UNSCOPED code too — the mock returns no rows
     * either way, so the throw proved nothing about scoping. Reverting the fix
     * failed one case of four, which is how I found it. What a real database
     * acts on is `FALSE` in the WHERE, so that is what this reads.
     *
     * 404 rather than 403 is still worth pinning: a caller told "forbidden" has
     * learned the ASN exists, which is the existence oracle CLAUDE.md §4 bars.
     */
    const { db, wheres } = chainDb([[]]);
    const { service: scope } = scopeOf([]);
    const service = serviceWith(db, scope);

    await expect(service.asnDetail("org-1", "picker-1", 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
  });

  it("narrows a scoped caller to their own warehouses, keeping unattributed rows", async () => {
    /*
     * `warehouse_id IS NULL OR IN (...)` — matching the LIST, deliberately.
     * An ASN with no warehouse attributed is visible to everyone in `listAsns`,
     * so a detail that refused those would 404 on rows the list had just shown.
     * This is a different rule from the labour records, where an unattributed
     * row is excluded; each detail follows its own aggregate.
     */
    const { db, wheres } = chainDb([[{ id: 42, warehouseId: 7 }], []]);
    const { service: scope } = scopeOf([7, 9]);
    const service = serviceWith(db, scope);

    await service.asnDetail("org-1", "supervisor-1", 42);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain('"warehouse_id" IS NULL OR');
    expect(text).toContain('"warehouse_id" in ($3, $4)');
  });

  it("consults the scope even for an org-wide reader, and then adds nothing", async () => {
    /*
     * "No warehouse predicate" cannot on its own tell an UNRESTRICTED reader
     * apart from an UNSCOPED method — which is the bug — so the absence is
     * asserted alongside proof that the scope was resolved at all.
     */
    const { db, wheres } = chainDb([[{ id: 42 }], []]);
    const { service: scope, consulted } = scopeOf(null);
    const service = serviceWith(db, scope);

    await service.asnDetail("org-1", "auditor-1", 42);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(wheres[0] as SQL)).not.toContain('"warehouse_id"');
  });

  it("does not put the read gate on the path that returns a row just written", () => {
    /*
     * `createAsn` ends by returning the ASN it created, and the writer is
     * entitled to see what they wrote — gating that would 404 a creator against
     * their own new record. The unscoped read is therefore a separate, named
     * private method rather than a flag on the public one, so a future route
     * cannot be pointed at it by accident.
     */
    const service = readFileSync(join(__dirname, "..", "quick-commerce-inbound.service.ts"), "utf8");
    const asnLib = readFileSync(
      join(__dirname, "..", "lib", "quick-commerce-asn.ts"),
      "utf8",
    );

    // The ungated read is still a named PRIVATE method on the service.
    expect(service).toContain("private async loadAsnUnscoped(");
    // ...and the create path still returns it.
    expect(asnLib).toContain("return deps.reloadUnscopedAsn(orgId, asnId.asnId);");
    // And the public one still resolves a scope.
    expect(service).toMatch(/async asnDetail\([^)]*userId: string[^)]*\)/);

    /*
     * `createAsn` moved to `lib/`, and the boundary moved with it rather than
     * being widened: the lib reaches the ungated read through a callback the
     * service binds in `qcDeps`, so nothing under `lib/` exports it and no
     * future route can import it. Asserted rather than trusted, because the
     * obvious way to do that split — export `loadAsnUnscoped` from the lib —
     * is exactly what the method's name exists to prevent.
     */
    for (const file of readdirSync(join(__dirname, "..", "lib"))) {
      const text = readFileSync(join(__dirname, "..", "lib", file), "utf8");
      expect({ file, mentionsUngatedRead: text.includes("loadAsnUnscoped") }).toEqual({
        file,
        mentionsUngatedRead: false,
      });
    }
    expect(service).toContain("reloadUnscopedAsn: (orgId, asnId) => this.loadAsnUnscoped(orgId, asnId)");
  });
});
