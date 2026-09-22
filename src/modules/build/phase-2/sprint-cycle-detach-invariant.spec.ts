import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BACKEND_SRC = join(__dirname, "..", "..", "..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_SRC, rel), "utf8");
}

function scanDir(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, results);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      results.push(full);
    }
  }
  return results;
}

const SCHEMA_DIR_PATTERN = /[/\\]db[/\\]schema[/\\]/;
const MIGRATION_PATTERN = /[/\\]migrations[/\\]/;

function isApplicationSource(filePath: string): boolean {
  if (SCHEMA_DIR_PATTERN.test(filePath)) return false;
  if (MIGRATION_PATTERN.test(filePath)) return false;
  return true;
}

const CONSUMER = src("modules/build/execution/build-sprint-completed-consumer.service.ts");
const DUE_SWEEP = src("modules/build/core/build-due-sweep.service.ts");
const WORK_ACTIONS = src("modules/ai/core/tools/work-actions-tools.ts");

describe("phase-04 detach invariant: owned execution paths use cycleId not sprintId", () => {
  it("build-sprint-completed-consumer no longer queries tickets.sprintId", () => {
    expect(CONSUMER).not.toContain("tickets.sprintId");
  });

  it("build-sprint-completed-consumer looks up cycle via cycles.legacySprintId", () => {
    expect(CONSUMER).toContain("cycles.legacySprintId");
  });

  it("build-sprint-completed-consumer queries tickets.cycleId for assignee lookup", () => {
    expect(CONSUMER).toContain("tickets.cycleId");
  });

  it("build-due-sweep no longer queries inArray(tickets.sprintId", () => {
    expect(DUE_SWEEP).not.toContain("tickets.sprintId");
  });

  it("build-due-sweep queries inArray(tickets.cycleId for cycle-ending owners", () => {
    expect(DUE_SWEEP).toContain("inArray(tickets.cycleId");
  });

  it("build-due-sweep queries cycles not sprints for ending iterations", () => {
    expect(DUE_SWEEP).toContain("cycles.status");
    expect(DUE_SWEEP).not.toContain("sprints.endDate");
  });

  it("work-actions-tools proposes ticket.moveToCycle not ticket.moveToSprint", () => {
    expect(WORK_ACTIONS).not.toContain('"ticket.moveToSprint"');
    expect(WORK_ACTIONS).toContain('"ticket.moveToCycle"');
  });

  it("work-actions-tools queries cycles not sprints by name", () => {
    expect(WORK_ACTIONS).not.toContain("sprints.name");
    expect(WORK_ACTIONS).toContain("cycles.name");
  });

  it("scanner is not vacuous: each source file contains substantial code", () => {
    expect(CONSUMER.length).toBeGreaterThan(500);
    expect(DUE_SWEEP.length).toBeGreaterThan(500);
    expect(WORK_ACTIONS.length).toBeGreaterThan(500);
  });
});

describe("phase-04 detach invariant: full application source allowlist", () => {
  const KNOWN_REMAINING: readonly string[] = [
    "modules/build/core/projects-tickets-read.service.ts",
    "modules/build/core/projects-tickets-workflow-utils.ts",
    "modules/build/core/projects-velocity-report.ts",
    "modules/build/core/projects-work-query-helpers.ts",
    "modules/build/core/projects-work-query.service.ts",
    "modules/build/execution/sprints.service.ts",
    "modules/dashboard/dashboard-project.service.ts",
  ].map((p) => p.replace(/\//g, require("node:path").sep));

  it("only the known-remaining files still reference tickets.sprintId — any new violator fails this gate, any cleared file requires allowlist update", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const violators = allFiles
      .filter((f) => readFileSync(f, "utf8").includes("tickets.sprintId"))
      .map((f) => relative(BACKEND_SRC, f));

    const sortedViolators = [...violators].sort();
    const sortedKnown = [...KNOWN_REMAINING].sort();
    expect(sortedViolators).toEqual(sortedKnown);
  });
});
