import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { DockService } from "../dock/dock.service";
import { SlottingService } from "../slotting/slotting.service";
import { HandlingUnitService } from "../handling-units/handling-unit.service";
import type { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { dbWith, scopeOf, sqlText, type DbHarness } from "./warehouse-scope-harness";

/**
 * Three commands that changed a document in a building the caller had never
 * been shown, and one thing they have in common: none of them posts stock.
 *
 * That is worth stating plainly, because it is what made all three survivable
 * everywhere else. `StockEngineService.executeInTx` calls
 * `assertLocationsInScope` on every movement, so a command that moves goods is
 * already refused at the engine. A dock appointment is a promise about a
 * vehicle, a slotting rule is a policy, a recommendation is a decision and a
 * nest is a claim about where something already is — not one of them reaches
 * the engine, so not one of them was refused by anything at all.
 *
 * Each list beside them has narrowed on the caller's warehouses since the
 * warehouse work landed. The commands were simply never told.
 */

const ORG = "org-1";

function dockWith(harness: DbHarness, scope: WarehouseScopeService) {
  return new DockService(harness.db, { insert: () => Promise.resolve() } as never, scope);
}

function slottingWith(harness: DbHarness, scope: WarehouseScopeService) {
  return new SlottingService(harness.db, { insert: () => Promise.resolve() } as never, scope);
}

function handlingUnitsWith(harness: DbHarness, scope: WarehouseScopeService) {
  const stub = {} as never;
  return new HandlingUnitService(harness.db, stub, stub, { insert: () => Promise.resolve() } as never, scope);
}

describe("a dock appointment, acted on by id", () => {
  it("refuses a status flip outside the caller's warehouses, and writes nothing", async () => {
    /*
     * The WHERE is the assertion, not the throw. The harness reports no updated
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code this was written to reject. An empty scope
     * compiles to FALSE, which is what a database acts on.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      dockWith(harness, scope).setStatus(ORG, "nobody-1", 42, "CANCELLED"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.updates).toHaveLength(1);
    expect(sqlText(harness.updates[0] as SQL)).toContain("FALSE");
  });

  it("narrows a scoped caller on the same column the list narrows on", async () => {
    /*
     * The drift guard. `list` and `setStatus` now read one private predicate
     * rather than two hand-copied readings of it: two copies agreeing today is
     * not the same as them being one, and the list gaining a scope the command
     * beside it was never told about is the whole defect.
     *
     * An appointment's warehouse is NOT NULL, so there is no null case to
     * decide here — unlike the ASN header, which keeps an `IS NULL` escape
     * because its warehouse may genuinely not be known yet.
     */
    const listHarness = dbWith();
    const updateHarness = dbWith();
    const { service: scope } = scopeOf([7, 9]);

    await dockWith(listHarness, scope).list(ORG, "picker-1", {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    } as never);
    await expect(
      dockWith(updateHarness, scope).setStatus(ORG, "picker-1", 42, "NO_SHOW"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const written = sqlText(updateHarness.updates[0] as SQL);
    expect(written).toContain('"inv_dock_appointments"."warehouse_id" IN (');
    expect(written).not.toContain("IS NULL");
    expect(sqlText(listHarness.wheres[0] as SQL)).toContain(
      '"inv_dock_appointments"."warehouse_id" IN (',
    );
  });

  it("consults the scope for an org-wide caller and then narrows nothing", async () => {
    // "No warehouse predicate" cannot on its own tell an UNRESTRICTED caller
    // from an UNSCOPED method — which is the defect — so the absence is asserted
    // beside proof that the scope was resolved at all.
    const harness = dbWith();
    const { service: scope, consulted } = scopeOf(null);

    await expect(
      dockWith(harness, scope).setStatus(ORG, "auditor-1", 42, "ARRIVED"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.updates[0] as SQL)).not.toContain("warehouse_id IN (");
  });
});

describe("a slotting rule and a re-slot recommendation", () => {
  it("refuses to toggle a rule in a warehouse the caller cannot see", async () => {
    /*
     * The quiet one. Disabling a stranger's rule posts nothing and shows
     * nothing; it arrives later through `slotFor`, when every putaway in that
     * building silently stops being ranked by the policy somebody wrote and the
     * goods go wherever the generic suggestion points.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      slottingWith(harness, scope).setRuleActive(ORG, "nobody-1", 42, false),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.updates).toHaveLength(1);
    expect(sqlText(harness.updates[0] as SQL)).toContain("FALSE");
  });

  it("refuses to dismiss a recommendation in a warehouse the caller cannot see", async () => {
    /*
     * `approve` was gated because approving ends with stock moving; dismiss was
     * left because it "touches nothing but the row". The row IS the decision:
     * DISMISSED is the state that tells the sweep somebody looked, so the move
     * is never proposed again — and `decided_by` is stamped with a person who
     * never saw it.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      slottingWith(harness, scope).dismiss(ORG, "nobody-1", 42, "no thanks"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.updates).toHaveLength(1);
    expect(sqlText(harness.updates[0] as SQL)).toContain("FALSE");
  });

  it("keeps the PENDING guard alongside the scope rather than instead of it", async () => {
    // One statement settles both, so there is no window between a check and the
    // write — and neither condition has quietly replaced the other.
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      slottingWith(harness, scope).dismiss(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const written = sqlText(harness.updates[0] as SQL);
    expect(written).toContain("'PENDING'");
    expect(written).toContain('"inv_slotting_recommendations"."warehouse_id" IN (');
  });

  it("builds the same predicate the two lists build", async () => {
    const { service: scope } = scopeOf([7, 9]);

    const rulesList = dbWith();
    await slottingWith(rulesList, scope).listRules(ORG, "picker-1");
    const ruleUpdate = dbWith();
    await expect(
      slottingWith(ruleUpdate, scope).setRuleActive(ORG, "picker-1", 42, true),
    ).rejects.toBeInstanceOf(NotFoundException);

    const recsList = dbWith();
    await slottingWith(recsList, scope).listRecommendations(ORG, "picker-1", {
      status: "PENDING",
      page: 1,
      limit: 20,
    } as never);
    const recUpdate = dbWith();
    await expect(
      slottingWith(recUpdate, scope).dismiss(ORG, "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const clause = (text: string, table: string) => {
      const at = text.indexOf(`"${table}"."warehouse_id" IN (`);
      expect(at).toBeGreaterThanOrEqual(0);
      return text.slice(at).replace(/\$\d+/g, "$?");
    };

    expect(clause(sqlText(ruleUpdate.updates[0] as SQL), "inv_slotting_rules")).toBe(
      clause(sqlText(rulesList.wheres[0] as SQL), "inv_slotting_rules"),
    );
    expect(
      clause(sqlText(recUpdate.updates[0] as SQL), "inv_slotting_recommendations"),
    ).toBe(clause(sqlText(recsList.wheres[0] as SQL), "inv_slotting_recommendations"));
  });
});

describe("nesting one handling unit inside another", () => {
  it("refuses a child the caller cannot see, before the transaction opens", async () => {
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      handlingUnitsWith(harness, scope).nest(ORG, "packer-1", 42, { parentHuId: 99 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The gate's own read is the only one that ran: nothing was written, and the
    // parent's kind and status were never in a position to be reported back.
    expect(harness.updates).toHaveLength(0);
  });

  it("asserts the DESTINATION pallet too, not only the carton", async () => {
    /*
     * The second door, and the one a gate on the child alone leaves open: take a
     * carton you legitimately hold and hang it onto a pallet in a building you
     * cannot see, and it is re-homed past every other gate this service has.
     *
     * A bespoke stub rather than the shared harness, because this is the one
     * case that has to get PAST the first gate: the child read must succeed and
     * `node` must answer, so the refusal can only be coming from the parent.
     * The shared harness's transaction handle deliberately refuses `execute`,
     * which is the right default everywhere else and is exactly wrong here.
     */
    const gateReads: unknown[][] = [[{ id: 42 }], []];
    const gateWheres: SQL[] = [];
    const updates: unknown[] = [];
    let read = 0;
    const chain: Record<string, unknown> = {
      from: () => chain,
      limit: () => chain,
      where: (statement: SQL) => {
        gateWheres.push(statement);
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
        Promise.resolve(gateReads[read++] ?? []).then(resolve, reject),
    };
    const tx = {
      select: () => chain,
      update: () => {
        updates.push(true);
        return chain;
      },
      // `node`'s raw read, answering for the child so the parent gate is reached.
      execute: () =>
        Promise.resolve([
          { id: 42, parent_hu_id: null, location_id: 5, status: "OPEN", holds_stock: false, child_count: 0 },
        ]),
    };
    const db = { transaction: (cb: (t: unknown) => unknown) => Promise.resolve(cb(tx)) } as never;
    const { service: scope } = scopeOf([7]);
    const stub = {} as never;
    const service = new HandlingUnitService(db, stub, stub, { insert: () => Promise.resolve() } as never, scope);

    await expect(
      service.nest(ORG, "packer-1", 42, { parentHuId: 99 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Two gate reads ran — the carton's and the pallet's — and nothing was
    // written. One read would mean the destination was never asked about.
    expect(gateWheres).toHaveLength(2);
    expect(updates).toHaveLength(0);
  });

  it("narrows on the unit's location, keeping this table's IS NULL escape", async () => {
    /*
     * The NULL rule differs by table on purpose and is asserted rather than
     * assumed. A handling unit with no location is visible to EVERYBODY here —
     * a unit is built before it is put anywhere, and hiding one from the person
     * who has just made it would be worse than the leak this closes. The labour
     * records go the other way and exclude an unattributed row. Each surface
     * follows its own aggregate, and `nest` follows this one because it reads
     * the very predicate `list` and `detail` read.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      handlingUnitsWith(harness, scope).nest(ORG, "packer-1", 42, { parentHuId: null }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(harness.wheres[0] as SQL);
    expect(text).toContain('"inv_handling_units"."location_id" IS NULL');
    expect(text).toContain("l.warehouse_id IN (");
  });

  it("lets an unrestricted caller through without a gate query at all", async () => {
    /*
     * The pass-through, asserted through the machinery BEHIND the gate: with no
     * predicate to apply, `nest` goes straight to `node`, whose raw `execute`
     * the harness's transaction handle deliberately refuses. That refusal is the
     * proof the gate was passed rather than silently skipped.
     */
    const harness = dbWith();
    const { service: scope, consulted } = scopeOf(null);

    await expect(
      handlingUnitsWith(harness, scope).nest(ORG, "auditor-1", 42, { parentHuId: 99 }),
    ).rejects.not.toBeInstanceOf(NotFoundException);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(harness.wheres).toHaveLength(0);
  });
});
