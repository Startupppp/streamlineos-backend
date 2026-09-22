import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
const SPRINTS_SVC = src("modules/build/execution/sprints.service.ts");
const DASHBOARD_SVC = src("modules/dashboard/dashboard-project.service.ts");
const VELOCITY_REPORT = src("modules/build/core/projects-velocity-report.ts");
const WORK_QUERY_SVC = src("modules/build/core/projects-work-query.service.ts");

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

  it("sprints.service listSprints bridges ticket lookup through cycles.legacySprintId not tickets.sprintId", () => {
    expect(SPRINTS_SVC).not.toContain("tickets.sprintId");
    expect(SPRINTS_SVC).toContain("cycles.legacySprintId");
    expect(SPRINTS_SVC).toContain("tickets.cycleId");
  });

  it("dashboard-project.service getActiveSprintSummary queries tickets.cycleId not tickets.sprintId", () => {
    expect(DASHBOARD_SVC).not.toContain("tickets.sprintId");
    expect(DASHBOARD_SVC).toContain("tickets.cycleId");
  });

  it("projects-velocity-report queries tickets.cycleId and groups by cycleId", () => {
    expect(VELOCITY_REPORT).not.toContain("tickets.sprintId");
    expect(VELOCITY_REPORT).toContain("tickets.cycleId");
    expect(VELOCITY_REPORT).toContain("cycles.id");
  });

  it("projects-work-query.service bridges sprintId filter through cycles.legacySprintId", () => {
    expect(WORK_QUERY_SVC).not.toContain("tickets.sprintId");
    expect(WORK_QUERY_SVC).toContain("cycles.legacySprintId");
  });

  it("scanner is not vacuous: each source file contains substantial code", () => {
    expect(CONSUMER.length).toBeGreaterThan(500);
    expect(DUE_SWEEP.length).toBeGreaterThan(500);
    expect(WORK_ACTIONS.length).toBeGreaterThan(500);
    expect(SPRINTS_SVC.length).toBeGreaterThan(500);
    expect(DASHBOARD_SVC.length).toBeGreaterThan(500);
    expect(VELOCITY_REPORT.length).toBeGreaterThan(200);
  });
});

describe("phase-04 detach invariant: full application source — property-access form", () => {
  const KNOWN_REMAINING: readonly string[] = [];

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

describe("phase-04 detach invariant: sprintId column-selection form (relational API blind spot)", () => {
  const KNOWN_COLUMN_SELECT_REMAINING: readonly string[] = [
    "modules/build/core/dto/build-tickets-response.schemas.ts",
  ].map((p) => p.replace(/\//g, sep));


  it("projects-tickets-read.query no longer selects sprintId: true — derives sprintId from cycle.legacySprintId instead", () => {
    const content = src("modules/build/core/projects-tickets-read.query.ts");
    expect(content).not.toMatch(/sprintId\s*:\s*true/);
    expect(content).toContain("legacySprintId: true");
    expect(content).toContain("row.cycle?.legacySprintId");
  });

  it("projects-tickets-update.service no longer selects sprintId: true from the DB — bridges sprintId write to cycleId instead", () => {
    const content = src("modules/build/core/projects-tickets-update.service.ts");
    expect(content).not.toMatch(/sprintId\s*:\s*true/);
    expect(content).toContain("cycles.legacySprintId");
    expect(content).toContain("updateData.cycleId");
  });

  it("build-tickets-response.schemas.ts carries sprintId: true only in a Zod .pick() call — not a DB column read, benign until the response contract removes sprintId", () => {
    const content = src("modules/build/core/dto/build-tickets-response.schemas.ts");
    expect(content).toContain("sprintId: true");
    expect(content).not.toContain("findMany");
    expect(content).not.toContain("findFirst");
    expect(content).not.toContain("cycles.legacySprintId");
  });

  it("only the known-remaining files still carry sprintId: true — catches the relational-API form that the property-access scan cannot see", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const columnSelectViolators = allFiles
      .filter((f) => /sprintId\s*:\s*true/.test(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f));

    const sortedViolators = [...columnSelectViolators].sort();
    const sortedKnown = [...KNOWN_COLUMN_SELECT_REMAINING].sort();
    expect(sortedViolators).toEqual(sortedKnown);
  });
});

const WRITE_OBJECT_LITERAL = /\bsprintId\s*:\s*(?:[A-Za-z_$][\w$]*\.)*sprintId\b/;
const WRITE_PROPERTY_ASSIGNMENT = /\.sprintId\s*=\s*[^=]/;

function hasSprintIdWriteForm(content: string): boolean {
  return WRITE_OBJECT_LITERAL.test(content) || WRITE_PROPERTY_ASSIGNMENT.test(content);
}

describe("phase-04 detach invariant: sprintId object-literal WRITE form (the blind spot that let four writes survive)", () => {
  const KNOWN_WRITE_REMAINING: readonly string[] = [
    "modules/build/qa/test-runs.service.ts",
  ].map((p) => p.replace(/\//g, sep));

  it("the write scanner is non-vacuous: it flags the exact pre-fix create-ticket text that both earlier scanners missed", () => {
    const preFixCreate = "        sprintId: body.sprintId,\n        epicId: body.epicId,";
    expect(preFixCreate).not.toContain("tickets.sprintId");
    expect(preFixCreate).not.toMatch(/sprintId\s*:\s*true/);
    expect(hasSprintIdWriteForm(preFixCreate)).toBe(true);
  });

  it("the write scanner is non-vacuous: it flags the exact pre-fix meetings create text that both earlier scanners missed", () => {
    const preFixMeetingCreate = "          sprintId: input.sprintId ?? null,\n          createdBy: u.userId,";
    expect(preFixMeetingCreate).not.toContain("tickets.sprintId");
    expect(preFixMeetingCreate).not.toMatch(/sprintId\s*:\s*true/);
    expect(hasSprintIdWriteForm(preFixMeetingCreate)).toBe(true);
  });

  it("the write scanner is non-vacuous: it flags the exact pre-fix meetings patch assignment that both earlier scanners missed", () => {
    const preFixMeetingPatch = "if (input.sprintId !== undefined) patch.sprintId = input.sprintId ?? null;";
    expect(preFixMeetingPatch).not.toContain("tickets.sprintId");
    expect(preFixMeetingPatch).not.toMatch(/sprintId\s*:\s*true/);
    expect(hasSprintIdWriteForm(preFixMeetingPatch)).toBe(true);
  });

  it("the write scanner does not fire on the cycle-derived read form, which is the shape every fixed call site now uses", () => {
    expect(hasSprintIdWriteForm("sprintId: row.cycle?.legacySprintId ?? null")).toBe(false);
    expect(hasSprintIdWriteForm("sprintId: cycleId == null ? null : legacyByCycleId.get(cycleId) ?? null")).toBe(false);
    expect(hasSprintIdWriteForm("expect(sprintId === undefined)")).toBe(false);
  });

  it("projects-tickets-create.service bridges body.sprintId to a cycleId and no longer writes tickets.sprint_id", () => {
    const content = src("modules/build/core/projects-tickets-create.service.ts");
    expect(hasSprintIdWriteForm(content)).toBe(false);
    expect(content).toContain("cycles.legacySprintId");
    expect(content).toContain("cycleId: resolvedCycleId");
  });

  it("meetings.service bridges the sprintId write to cycleId and derives the sprintId response field from cycles.legacySprintId", () => {
    const content = src("modules/build/meetings/meetings.service.ts");
    expect(hasSprintIdWriteForm(content)).toBe(false);
    expect(content).toContain("cycles.legacySprintId");
    expect(content).toContain("cycleId: resolvedCycleId");
    expect(content).toContain("attachSprintIds");
  });

  it("sprints.service getSprint loads tickets by cycleId instead of traversing the sprints-to-tickets relation", () => {
    const content = src("modules/build/execution/sprints.service.ts");
    expect(content).not.toContain("tickets: {");
    expect(content).toContain("eq(tickets.cycleId, bridgedCycle.id)");
  });

  it("only the known-remaining files still write sprintId from a request-sourced value — qa/test-runs.service.ts is owned by a concurrent agent in this same cutover", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const writeViolators = allFiles
      .filter((f) => hasSprintIdWriteForm(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f));

    const sortedViolators = [...writeViolators].sort();
    const sortedKnown = [...KNOWN_WRITE_REMAINING].sort();
    expect(sortedViolators).toEqual(sortedKnown);
  });
});
