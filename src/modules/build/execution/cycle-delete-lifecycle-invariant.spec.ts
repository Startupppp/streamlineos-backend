import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { cycles } from "../../../db/schema";
import { cycleScopeEvents } from "../../../db/schema/build/cycle-events";

const SRC = join(__dirname, "..", "..", "..");

const TOMBSTONE_BLIND_READERS = [
  join(SRC, "modules", "ai", "core", "services", "projects-ai.service.ts"),
  join(SRC, "modules", "ai", "core", "tools", "work-actions-tools.ts"),
  join(SRC, "modules", "build", "entity", "build-entity-reads.service.ts"),
  join(SRC, "modules", "dashboard", "dashboard-project.service.ts"),
];

function predicateExcludesTombstones(where: unknown): boolean {
  const columns: string[] = [];
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if ("queryChunks" in node) {
      visit(node.queryChunks);
      return;
    }
    if ("value" in node && Array.isArray(node.value)) {
      fragments.push(node.value.join(""));
      return;
    }
    if ("name" in node && typeof node.name === "string" && "table" in node) {
      columns.push(node.name);
    }
  };
  visit(where);
  return columns.includes("deleted_at") && /is\s+null/i.test(fragments.join(" "));
}

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

  it("has no unique index a tombstoned row could collide on: each unique either carries the primary key or excludes deleted rows by predicate", () => {
    const config = getTableConfig(cycles);
    const uniques = [
      ...config.uniqueConstraints.map((u) => ({
        name: u.name,
        columns: u.columns.map((c) => c.name),
        where: undefined,
      })),
      ...config.indexes
        .filter((index) => index.config.unique)
        .map((index) => ({
          name: index.config.name,
          columns: (index.config.columns ?? []).map((c) => ("name" in c ? c.name : String(c))),
          where: index.config.where,
        })),
    ];
    expect(uniques.length).toBeGreaterThan(0);
    const unsafe = uniques
      .filter((u) => !u.columns.includes("id") && !predicateExcludesTombstones(u.where))
      .map((u) => u.name);
    expect(unsafe).toEqual([]);
  });

  it("bite proof: the predicate arm is a real check, not a rubber stamp — a partial unique whose predicate ignores the tombstone is still unsafe", () => {
    expect(predicateExcludesTombstones(undefined)).toBe(false);
    expect(predicateExcludesTombstones(sql`${cycles.status} = 'active'`)).toBe(false);
    expect(predicateExcludesTombstones(sql`${cycles.deletedAt} IS NOT NULL`)).toBe(false);
    expect(
      predicateExcludesTombstones(sql`${cycles.status} = 'active' AND ${cycles.deletedAt} IS NULL`),
    ).toBe(true);
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
      join(SRC, "modules", "build", "core", "analytics", "projects-velocity-report.ts"),
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
