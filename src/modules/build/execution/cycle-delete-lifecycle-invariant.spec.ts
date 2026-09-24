import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { cycles } from "../../../db/schema";
import { cycleScopeEvents } from "../../../db/schema/build/cycle-events";

/**
 * Why cycle deletion is still a hard delete.
 *
 * The question this answers is whether the model supports turning
 * `CyclesService.deleteCycle` into a soft delete. Three of the four
 * preconditions hold; the fourth does not, and it is the one that would leak.
 *
 * Holds:  the column exists, no unique index can collide on a tombstone, and
 *         every read inside this module already filters it.
 * Fails:  readers OUTSIDE this lane read `build.cycles` with no tombstone
 *         filter, so flipping the delete would make deleted cycles reappear on
 *         their surfaces. Those files are not this lane's to change.
 *
 * The cost of NOT converting is real and recorded below: the FK from
 * `cycle_scope_events` is ON DELETE SET NULL, so a hard delete orphans the
 * burnup history rather than removing it.
 *
 * When the out-of-lane readers gain the filter, the reader test here fails --
 * deliberately. That failure is the signal that soft delete became safe.
 */

const SRC = join(__dirname, "..", "..", "..");

const TOMBSTONE_BLIND_READERS = [
  join(SRC, "modules", "ai", "core", "services", "projects-ai.service.ts"),
  join(SRC, "modules", "ai", "core", "tools", "work-actions-tools.ts"),
  join(SRC, "modules", "build", "entity", "build-entity-reads.service.ts"),
  join(SRC, "modules", "dashboard", "dashboard-project.service.ts"),
];

function readsCyclesWithoutTombstoneFilter(file: string): boolean {
  const text = readFileSync(file, "utf8");
  let index = text.indexOf(".from(cycles)");
  while (index >= 0) {
    const window = text.slice(index, index + 600);
    if (!window.includes("cycles.deletedAt")) return true;
    index = text.indexOf(".from(cycles)", index + 1);
  }
  return false;
}

describe("build.cycles is shaped for soft delete", () => {
  it("carries a deleted_at column, so the tombstone has somewhere to live", () => {
    const columns = getTableConfig(cycles).columns.map((column) => column.name);
    expect(columns).toContain("deleted_at");
  });

  it("has no unique index a tombstoned row could collide on, because every unique it declares includes the primary key", () => {
    const config = getTableConfig(cycles);
    const uniques = [
      ...config.uniqueConstraints.map((u) => ({
        name: u.name,
        columns: u.columns.map((c) => c.name),
      })),
      ...config.indexes
        .filter((index) => index.config.unique)
        .map((index) => ({
          name: index.config.name,
          columns: (index.config.columns ?? []).map((c) => ("name" in c ? c.name : String(c))),
        })),
    ];
    expect(uniques.length).toBeGreaterThan(0);
    for (const unique of uniques) expect(unique.columns).toContain("id");
  });

  it("bite proof: a unique on (org_id, project_id, name) would raise 23505 the second time a name were reused after a soft delete", () => {
    const columns = getTableConfig(cycles).uniqueConstraints.flatMap((u) =>
      u.columns.map((c) => c.name),
    );
    expect(columns).not.toContain("name");
  });

  it("already carries partial indexes predicated on the tombstone, so the planner is prepared for it", () => {
    const partials = getTableConfig(cycles)
      .indexes.map((index) => index.config.where)
      .filter((where) => where !== undefined);
    expect(partials.length).toBeGreaterThanOrEqual(2);
  });
});

describe("hard delete is still required, and what it costs", () => {
  it("is blocked by readers outside this lane that would surface tombstoned cycles", () => {
    const blind = TOMBSTONE_BLIND_READERS.filter(readsCyclesWithoutTombstoneFilter);
    expect(blind.length).toBeGreaterThan(0);
  });

  it("is not blocked by this module's own reads, which all filter the tombstone already", () => {
    const service = readFileSync(join(__dirname, "cycles.service.ts"), "utf8");
    const listing = service.slice(service.indexOf("async listCycles"), service.indexOf("async createCycle"));
    expect(listing).toContain("isNull(cycles.deletedAt)");
    const overlap = service.slice(service.indexOf("async createCycle"), service.indexOf("async updateCycle"));
    expect(overlap).toContain("isNull(cycles.deletedAt)");
  });

  it("is not blocked by the velocity report, which already excludes tombstoned cycles", () => {
    const velocity = readFileSync(
      join(SRC, "modules", "build", "core", "projects-velocity-report.ts"),
      "utf8",
    );
    expect(velocity).toContain("isNull(cycles.deletedAt)");
  });

  it("costs the burnup history: the scope-event FK is ON DELETE SET NULL, so a removed cycle orphans its events rather than deleting them", () => {
    const cycleFk = getTableConfig(cycleScopeEvents).foreignKeys.find(
      (fk) => fk.reference().foreignTable === cycles,
    );
    expect(cycleFk).toBeDefined();
    expect(cycleFk?.onDelete).toBe("set null");
  });

  it("detaches tickets before removing the cycle, so no ticket is left pointing at a row that is gone", () => {
    const service = readFileSync(join(__dirname, "cycles.service.ts"), "utf8");
    const remove = service.slice(service.indexOf("async deleteCycle"));
    expect(remove.indexOf("set({ cycleId: null })")).toBeGreaterThan(-1);
    expect(remove.indexOf("set({ cycleId: null })")).toBeLessThan(remove.indexOf(".delete(cycles)"));
    expect(remove).toContain("this.db.transaction");
  });
});
