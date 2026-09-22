import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SQL_DIR = join(REPO_ROOT, "docs", "phase-2", "sql");

const FORWARD_PHASES = [
  "a-sprint-cycle-01-expand.sql",
  "a-sprint-cycle-02-backfill.sql",
  "a-sprint-cycle-03-constrain.sql",
  "a-sprint-cycle-04-detach.sql",
  "a-sprint-cycle-05-drop.sql",
];

const BACKFILL = "a-sprint-cycle-02-backfill.sql";

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8").replace(/\r\n/g, "\n");
}

function readSql(name: string): string {
  return read(SQL_DIR, name);
}

function stripSqlComments(sql: string): string {
  const marker = "__BREAKPOINT__";
  return sql
    .split("--> statement-breakpoint")
    .join(marker)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(marker)
    .join("--> statement-breakpoint");
}

function bracketList(source: string, anchor: RegExp): string[] {
  const match = anchor.exec(source);
  if (!match) throw new Error(`anchor did not match: ${anchor}`);
  return Array.from(match[1].matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
}

const enumsSource = read(REPO_ROOT, "src", "db", "schema", "common", "enums.ts");
const coreSource = read(REPO_ROOT, "src", "db", "schema", "build", "core.ts");
const ticketCoreSource = read(REPO_ROOT, "src", "db", "schema", "build", "ticket-core.ts");
const iterationsDtoSource = read(
  REPO_ROOT, "src", "modules", "build", "execution", "dto", "iterations.schemas.ts",
);
const iterationsControllerSource = read(
  REPO_ROOT, "src", "modules", "build", "execution", "iterations.controller.ts",
);
const backfillSql = readSql(BACKFILL);

const CYCLE_STATUS_VALUES = bracketList(
  enumsSource,
  /cycleStatusEnum\s*=\s*pgEnum\(\s*"cycle_status"\s*,\s*\[([^\]]*)\]/,
);

const SPRINT_STATUS_VALUES = bracketList(
  coreSource,
  /"chk_sprints_status"[\s\S]{0,160}?\$\{table\.status\}\s+IN\s*\(([^)]*)\)/,
);

const CYCLE_STATUS_DEFAULT = (() => {
  const m = /cycleStatusEnum\("status"\)\.default\("([^"]+)"\)/.exec(coreSource);
  if (!m) throw new Error("cycles.status default not found in core.ts");
  return m[1];
})();

const SPRINT_STATUS_DEFAULT = (() => {
  const m = /status:\s*text\("status"\)\.default\("([^"]+)"\)/.exec(coreSource);
  if (!m) throw new Error("sprints.status default not found in core.ts");
  return m[1];
})();

function parseCaseArms(sql: string): { arms: Map<string, string>; fallback: string | null } {
  const block = /CASE\s+upper\(btrim\(coalesce\(s\."status",\s*''\)\)\)([\s\S]*?)\bEND\b/.exec(sql);
  if (!block) throw new Error("status CASE expression not found in the backfill SQL");
  const body = block[1];
  const arms = new Map<string, string>();
  for (const m of body.matchAll(/WHEN\s+'([^']+)'\s+THEN\s+'([^']+)'/g)) {
    if (arms.has(m[1])) throw new Error(`duplicate WHEN arm for ${m[1]}`);
    arms.set(m[1], m[2]);
  }
  const elseArm = /ELSE\s+'([^']+)'/.exec(body);
  return { arms, fallback: elseArm ? elseArm[1] : null };
}

function normaliseSourceStatus(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

function mapStatus(raw: string | null | undefined): string {
  const { arms, fallback } = parseCaseArms(backfillSql);
  const key = normaliseSourceStatus(raw);
  const hit = arms.get(key);
  if (hit !== undefined) return hit;
  if (fallback === null) throw new Error("mapping is not total: no ELSE arm");
  return fallback;
}

describe("sprint status vocabulary is read from source, not assumed", () => {
  it("reads the cycle_status pgEnum members out of src/db/schema/common/enums.ts", () => {
    expect(CYCLE_STATUS_VALUES).toEqual(["draft", "active", "completed"]);
  });

  it("reads the sprints.status CHECK vocabulary out of src/db/schema/build/core.ts", () => {
    expect(SPRINT_STATUS_VALUES).toEqual(["PLANNED", "ACTIVE", "COMPLETED"]);
  });

  it("finds a non-empty vocabulary on both sides so the mapping tests cannot be vacuous", () => {
    expect(SPRINT_STATUS_VALUES.length).toBeGreaterThan(0);
    expect(CYCLE_STATUS_VALUES.length).toBeGreaterThan(0);
  });

  it("agrees with the updateSprintSchema request contract", () => {
    const zod = bracketList(iterationsDtoSource, /status:\s*z\.enum\(\[([^\]]*)\]\)\.optional\(\),\s*\}\)\.strict\(\)\s*\n\s*\.superRefine/);
    expect(zod.sort()).toEqual([...SPRINT_STATUS_VALUES].sort());
  });

  it("agrees with the cycleListQuerySchema request contract", () => {
    const zod = bracketList(
      iterationsDtoSource,
      /cycleListQuerySchema\s*=\s*z\.object\(\{\s*status:\s*z\.enum\(\[([^\]]*)\]\)/,
    );
    expect(zod).toEqual(CYCLE_STATUS_VALUES);
  });
});

describe("the backfill status mapping is total and deterministic", () => {
  it("names every sprint status in a WHEN arm", () => {
    const { arms } = parseCaseArms(backfillSql);
    for (const value of SPRINT_STATUS_VALUES) expect(arms.has(value)).toBe(true);
  });

  it("names no source value the sprints CHECK constraint does not permit", () => {
    const { arms } = parseCaseArms(backfillSql);
    expect([...arms.keys()].sort()).toEqual([...SPRINT_STATUS_VALUES].sort());
  });

  it("targets only members of the real cycle_status enum", () => {
    const { arms, fallback } = parseCaseArms(backfillSql);
    for (const target of arms.values()) expect(CYCLE_STATUS_VALUES).toContain(target);
    expect(CYCLE_STATUS_VALUES).toContain(fallback);
  });

  it("carries an ELSE arm so an unexpected stored value still has a target", () => {
    expect(parseCaseArms(backfillSql).fallback).not.toBeNull();
    expect(mapStatus("SOMETHING_NOBODY_WROTE")).toBe(CYCLE_STATUS_DEFAULT);
  });

  it("routes NULL through coalesce to the same target as the cycles.status column default", () => {
    expect(backfillSql).toContain(`coalesce(s."status", '')`);
    expect(mapStatus(null)).toBe(CYCLE_STATUS_DEFAULT);
    expect(mapStatus(undefined)).toBe(CYCLE_STATUS_DEFAULT);
    expect(mapStatus("")).toBe(CYCLE_STATUS_DEFAULT);
  });

  it("maps the sprints.status column default to the cycles.status column default", () => {
    expect(mapStatus(SPRINT_STATUS_DEFAULT)).toBe(CYCLE_STATUS_DEFAULT);
  });

  it("is injective over the declared vocabulary so no two sprint states collapse", () => {
    const targets = SPRINT_STATUS_VALUES.map((v) => mapStatus(v));
    expect(new Set(targets).size).toBe(SPRINT_STATUS_VALUES.length);
  });

  it("normalises case and surrounding whitespace before matching", () => {
    expect(backfillSql).toContain("upper(btrim(");
    for (const value of SPRINT_STATUS_VALUES) {
      expect(mapStatus(`  ${value.toLowerCase()} `)).toBe(mapStatus(value));
    }
  });

  it("returns the same target on repeated evaluation of the same input", () => {
    const inputs = [...SPRINT_STATUS_VALUES, null, "", "unexpected"];
    for (const input of inputs) expect(mapStatus(input)).toBe(mapStatus(input));
  });
});

describe("the consolidation SQL obeys the migration discipline gate", () => {
  const files = [...FORWARD_PHASES, ...FORWARD_PHASES.map((f) => f.replace(/\.sql$/, "-rollback.sql"))];

  it.each(files)("%s exists", (name) => {
    expect(existsSync(join(SQL_DIR, name))).toBe(true);
  });

  it.each(files)("%s sets lock_timeout", (name) => {
    expect(/set\s+lock_timeout/i.test(readSql(name))).toBe(true);
  });

  it.each(files)("%s adds no foreign key without NOT VALID", (name) => {
    for (const stmt of readSql(name).split("--> statement-breakpoint")) {
      if (/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(stmt)) {
        expect(/NOT\s+VALID/i.test(stmt)).toBe(true);
      }
    }
  });

  it.each(files)("%s puts no statement-breakpoint inside a DO block", (name) => {
    for (const m of readSql(name).matchAll(/DO\s+\$\$[\s\S]*?\$\$/gi)) {
      expect(m[0].includes("--> statement-breakpoint")).toBe(false);
    }
  });

  it.each(files)("%s creates no index CONCURRENTLY", (name) => {
    const body = readSql(name).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body)).toBe(false);
  });

  it.each(files)("%s precedes any SET NOT NULL with a CHECK IS NOT NULL NOT VALID", (name) => {
    const sql = readSql(name);
    if (!/SET\s+NOT\s+NULL/i.test(sql)) return;
    expect(/CHECK\s*\([^)]*IS\s+NOT\s+NULL[^)]*\)\s+NOT\s+VALID/i.test(sql)).toBe(true);
  });

  it.each(files)("%s never validates a constraint before its backfill UPDATE", (name) => {
    const stmts = stripSqlComments(readSql(name)).split("--> statement-breakpoint");
    const validateIdx = stmts.findIndex((s) => /VALIDATE\s+CONSTRAINT/i.test(s));
    const backfillIdx = stmts.findIndex((s) => /UPDATE\s+\S+[\s\S]*?WHERE/i.test(s));
    if (validateIdx === -1 || backfillIdx === -1) return;
    expect(validateIdx).toBeGreaterThan(backfillIdx);
  });

  it("gives every composite SET NULL foreign key an explicit column list", () => {
    let matched = 0;
    for (const name of files) {
      for (const stmt of readSql(name).split("--> statement-breakpoint")) {
        if (!/FOREIGN\s+KEY\s*\(\s*"org_id"\s*,/i.test(stmt)) continue;
        if (!/ON\s+DELETE\s+SET\s+NULL/i.test(stmt)) continue;
        matched += 1;
        expect(/ON\s+DELETE\s+SET\s+NULL\s*\(\s*"[a-z_]+"\s*\)/i.test(stmt)).toBe(true);
      }
    }
    expect(matched).toBeGreaterThan(0);
  });
});

describe("the backfill is re-runnable and row-order independent", () => {
  it("derives no value from a clock or a random source", () => {
    const body = stripSqlComments(backfillSql);
    expect(/\bnow\s*\(/i.test(body)).toBe(false);
    expect(/\bcurrent_(date|timestamp|time)\b/i.test(body)).toBe(false);
    expect(/\brandom\s*\(/i.test(body)).toBe(false);
  });

  it("guards every INSERT with a conflict clause or a NOT EXISTS predicate", () => {
    let matched = 0;
    for (const stmt of stripSqlComments(backfillSql).split("--> statement-breakpoint")) {
      if (!/\bINSERT\s+INTO\b/i.test(stmt)) continue;
      matched += 1;
      expect(/ON\s+CONFLICT|NOT\s+EXISTS/i.test(stmt)).toBe(true);
    }
    expect(matched).toBe(4);
  });

  it("records the pre-migration binding once and never rewrites it on a re-run", () => {
    let matched = 0;
    for (const stmt of stripSqlComments(backfillSql).split("--> statement-breakpoint")) {
      if (!/INSERT\s+INTO\s+"build"\."sprint_binding_archive"/i.test(stmt)) continue;
      matched += 1;
      expect(/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(stmt)).toBe(true);
    }
    expect(matched).toBe(2);
  });

  it("only assigns cycle_id where it is still null, so a disagreeing cycle_id wins", () => {
    let matched = 0;
    for (const stmt of stripSqlComments(backfillSql).split("--> statement-breakpoint")) {
      if (!/^\s*UPDATE\s+"build(_events)?"\."/i.test(stmt)) continue;
      if (!/SET\s+"cycle_id"/i.test(stmt)) continue;
      matched += 1;
      expect(/"cycle_id"\s+IS\s+NULL/i.test(stmt)).toBe(true);
    }
    expect(matched).toBe(4);
  });

  it("carries org_id in the predicate of every statement that joins the migration map", () => {
    let matched = 0;
    for (const stmt of stripSqlComments(backfillSql).split("--> statement-breakpoint")) {
      if (!/sprint_cycle_migration_map/i.test(stmt)) continue;
      matched += 1;
      expect(/"org_id"/i.test(stmt)).toBe(true);
    }
    expect(matched).toBeGreaterThanOrEqual(7);
  });

  it("fails loudly rather than silently partially when a sprint has no cycle", () => {
    expect(backfillSql).toMatch(/RAISE\s+EXCEPTION[\s\S]*sprint row\(s\) have no cycle counterpart/);
  });

  it("keys the identity of a migrated cycle on legacy_sprint_id, not on an id range", () => {
    expect(backfillSql).toContain(`c."legacy_sprint_id" = s."id"`);
    const rollback = readSql("a-sprint-cycle-02-backfill-rollback.sql");
    expect(rollback).toContain(`DELETE FROM "build"."cycles" c WHERE c."legacy_sprint_id" IS NOT NULL`);
  });
});

describe("dual identity tripwire", () => {
  const removal = "delete this assertion in the same change that lands a-sprint-cycle-05-drop.sql";

  it(`build.sprints is still declared alongside build.cycles — ${removal}`, () => {
    expect(coreSource).toContain(`export const sprints = build.table(`);
    expect(coreSource).toContain(`export const cycles = build.table(`);
  });

  it(`tickets still carries both sprintId and cycleId — ${removal}`, () => {
    expect(ticketCoreSource).toContain(`sprintId: integer("sprint_id")`);
    expect(ticketCoreSource).toContain(`cycleId: integer("cycle_id")`);
  });

  it(`tickets still declares both composite foreign keys — ${removal}`, () => {
    expect(ticketCoreSource).toContain(`name: "fk_tickets_org_sprint"`);
    expect(ticketCoreSource).toContain(`name: "fk_tickets_org_cycle"`);
  });

  it(`both SprintsController and CyclesController are still mounted — ${removal}`, () => {
    expect(iterationsControllerSource).toContain(`@Controller("build/:projectId/sprints")`);
    expect(iterationsControllerSource).toContain(`@Controller("build/:projectId/cycles")`);
  });

  it(`three satellite tables still point at sprints — ${removal}`, () => {
    const meetings = read(REPO_ROOT, "src", "db", "schema", "build", "meetings.ts");
    const qa = read(REPO_ROOT, "src", "db", "schema", "build", "qa.ts");
    const events = read(REPO_ROOT, "src", "db", "schema", "build", "sprint-events.ts");
    expect(meetings).toContain(`name: "fk_project_meetings_org_sprint"`);
    expect(qa).toContain(`name: "fk_test_runs_org_sprint"`);
    expect(events).toContain(`name: "fk_sprint_scope_events_org_sprint"`);
  });

  it(`CyclesController still has no detail route, so cycle reads depend on the capped list — ${removal}`, () => {
    const cyclesBlock = iterationsControllerSource.slice(
      iterationsControllerSource.indexOf("export class CyclesController"),
      iterationsControllerSource.indexOf("export class ModulesController"),
    );
    expect(cyclesBlock.length).toBeGreaterThan(0);
    expect(cyclesBlock).not.toContain(`@Get(":cycleId")`);
  });

  it(`cycles has no deleted_at while sprints soft-deletes — ${removal}`, () => {
    const cyclesBlock = coreSource.slice(
      coreSource.indexOf("export const cycles = build.table("),
      coreSource.indexOf("export const modules = build.table("),
    );
    expect(cyclesBlock.length).toBeGreaterThan(0);
    expect(cyclesBlock).not.toContain(`deletedAt`);
    expect(coreSource).toContain(`deletedAt: timestamp("deleted_at", { withTimezone: true }),`);
  });
});
