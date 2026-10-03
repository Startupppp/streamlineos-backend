import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND_ROOT = resolve(__dirname, "../../../..");
const MIGRATIONS_DIR = join(BACKEND_ROOT, "migrations");

const REPAIR = "1144_repair_inventory_composite_set_null.sql";
const ROLLBACK = "rollback/1144_repair_inventory_composite_set_null.down.sql";

const KEYS = [
  {
    constraint: "fk_inv_sales_orders_channel_id_org",
    table: "inv_sales_orders",
    nullableColumn: "channel_id",
    parent: "inv_channels",
    installedBy: "0580a_inventory_channel_pools.sql",
  },
  {
    constraint: "fk_inv_stock_adjustments_scrap_location_id_org",
    table: "inv_stock_adjustments",
    nullableColumn: "scrap_location_id",
    parent: "inv_locations",
    installedBy: "0545a_stock_write_off.sql",
  },
];

function read(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8").replace(/\r\n/g, "\n");
}

function statementsOf(name: string): string[] {
  return read(name).split("--> statement-breakpoint");
}

function addConstraintStatement(name: string, constraint: string): string {
  const stmt = statementsOf(name).find(
    (s) => s.includes(`ADD CONSTRAINT "${constraint}"`),
  );
  if (stmt === undefined) throw new Error(`${name} does not add ${constraint}`);
  return stmt;
}

describe("the two surviving bare composite SET NULL keys have an authored repair", () => {
  it.each([REPAIR, ROLLBACK])("%s exists", (name) => {
    expect(existsSync(join(MIGRATIONS_DIR, name))).toBe(true);
  });

  it.each([REPAIR, ROLLBACK])("%s sets lock_timeout so it fails fast instead of queueing", (name) => {
    expect(/SET\s+lock_timeout/i.test(read(name))).toBe(true);
  });

  it.each([REPAIR, ROLLBACK])("%s adds every foreign key as NOT VALID before validating it", (name) => {
    for (const stmt of statementsOf(name)) {
      if (!/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(stmt)) continue;
      expect(/NOT\s+VALID/i.test(stmt)).toBe(true);
    }
  });

  it.each([REPAIR, ROLLBACK])("%s uses no DO block, so no breakpoint can land inside one", (name) => {
    expect(read(name)).not.toMatch(/DO\s+\$\$/i);
  });
});

describe.each(KEYS)("$constraint", ({ constraint, table, nullableColumn, parent, installedBy }) => {
  it("is still installed in the bare form by the migration that created it", () => {
    const source = readFileSync(join(MIGRATIONS_DIR, installedBy), "utf8").replace(/\r\n/g, "\n");
    const installed = source
      .split("--> statement-breakpoint")
      .find((s) => s.includes(`ADD CONSTRAINT "${constraint}"`));
    expect(installed).toBeDefined();
    expect(installed === undefined ? "" : installed).toMatch(/ON\s+DELETE\s+SET\s+NULL\s+NOT\s+VALID/i);
  });

  it("is repaired with a column list naming only the nullable member", () => {
    const stmt = addConstraintStatement(REPAIR, constraint);
    const list = /ON\s+DELETE\s+SET\s+NULL\s*\(([^)]*)\)/i.exec(stmt);
    expect(list).not.toBeNull();
    const columns = (list === null ? "" : list[1]).split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(columns).toEqual([nullableColumn]);
  });

  it("never names the tenant column in the column list, which is the defect 1142 repaired", () => {
    const list = /ON\s+DELETE\s+SET\s+NULL\s*\(([^)]*)\)/i.exec(addConstraintStatement(REPAIR, constraint));
    expect(list === null ? "" : list[1]).not.toMatch(/org_id/i);
  });

  it("changes only the delete action, keeping the key and its parent columns identical", () => {
    const stmt = addConstraintStatement(REPAIR, constraint);
    expect(stmt).toMatch(
      new RegExp(`FOREIGN\\s+KEY\\s*\\(\\s*"org_id"\\s*,\\s*"${nullableColumn}"\\s*\\)`, "i"),
    );
    expect(stmt).toMatch(new RegExp(`REFERENCES\\s+(?:"public"\\.)?"${parent}"\\s*\\(\\s*"org_id"\\s*,\\s*"id"\\s*\\)`, "i"));
  });

  it("drops the old constraint before re-adding it, so the repair is re-runnable", () => {
    expect(read(REPAIR)).toMatch(new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+"${constraint}"`, "i"));
  });

  it("alters the table the constraint actually lives on", () => {
    expect(addConstraintStatement(REPAIR, constraint)).toMatch(
      new RegExp(`ALTER\\s+TABLE\\s+(?:"public"\\.)?"${table}"`, "i"),
    );
  });

  it("validates the repaired constraint, because the same key was already validated when installed", () => {
    expect(read(REPAIR)).toMatch(new RegExp(`VALIDATE\\s+CONSTRAINT\\s+"${constraint}"`, "i"));
  });

  it("is restored to the defective bare form by the rollback, which is a step and never a resting state", () => {
    const stmt = addConstraintStatement(ROLLBACK, constraint);
    expect(stmt).toMatch(/ON\s+DELETE\s+SET\s+NULL\s*\n?\s*NOT\s+VALID/i);
    expect(stmt).not.toMatch(/ON\s+DELETE\s+SET\s+NULL\s*\(/i);
  });
});

describe("the declarations the repair is derived from have not moved", () => {
  it("declares inv_sales_orders.channel_id nullable, so SET NULL on it is reachable", () => {
    const source = readFileSync(join(BACKEND_ROOT, "src/db/schema/inventory/sales-orders.ts"), "utf8");
    const declaration = /channelId:\s*integer\("channel_id"\)[^\n]*/.exec(source);
    expect(declaration).not.toBeNull();
    const line = declaration === null ? "" : declaration[0];
    expect(line).toMatch(/onDelete:\s*"set null"/);
    expect(line).not.toMatch(/\.notNull\(\)/);
  });

  it("declares inv_stock_adjustments.scrap_location_id nullable", () => {
    const source = readFileSync(join(BACKEND_ROOT, "src/db/schema/inventory/stock.ts"), "utf8");
    expect(source).toMatch(/scrapLocationId:\s*integer\("scrap_location_id"\)\s*,/);
  });

  it("declares inv_sales_orders.org_id NOT NULL, which is why the bare form raises 23502", () => {
    const source = readFileSync(join(BACKEND_ROOT, "src/db/schema/inventory/sales-orders.ts"), "utf8");
    expect(source).toMatch(/orgId:\s*text\("org_id"\)[\s\S]{0,140}?\.notNull\(\)/);
  });
});
