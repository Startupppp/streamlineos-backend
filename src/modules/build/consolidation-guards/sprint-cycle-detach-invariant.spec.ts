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

const DUE_SWEEP = src("modules/build/core/build-due-sweep.service.ts");
const WORK_ACTIONS = src("modules/ai/core/tools/work-actions-tools.ts");
const SPRINTS_SVC = src("modules/build/execution/sprints.service.ts");
const DASHBOARD_SVC = src("modules/dashboard/dashboard-project.service.ts");
const VELOCITY_REPORT = src("modules/build/core/projects-velocity-report.ts");
const WORK_QUERY_SVC = src("modules/build/core/projects-work-query.service.ts");

describe("phase-04 detach invariant: owned execution paths use cycleId not sprintId", () => {
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

  it("dashboard-project.service getActiveSprintSummary queries tickets.cycleId not tickets.sprintId", () => {
    expect(DASHBOARD_SVC).not.toContain("tickets.sprintId");
    expect(DASHBOARD_SVC).toContain("tickets.cycleId");
  });

  it("projects-velocity-report queries tickets.cycleId and groups by cycleId", () => {
    expect(VELOCITY_REPORT).not.toContain("tickets.sprintId");
    expect(VELOCITY_REPORT).toContain("tickets.cycleId");
    expect(VELOCITY_REPORT).toContain("cycles.id");
  });

  it("projects-work-query.service filters on tickets.cycleId alone, with no legacy sprint bridge left", () => {
    expect(WORK_QUERY_SVC).not.toContain("tickets.sprintId");
    expect(WORK_QUERY_SVC).not.toContain("legacySprintId");
    expect(WORK_QUERY_SVC).toContain("inArray(tickets.cycleId");
  });

  it("scanner is not vacuous: each source file contains substantial code", () => {
    expect(DUE_SWEEP.length).toBeGreaterThan(500);
    expect(WORK_ACTIONS.length).toBeGreaterThan(500);
    expect(SPRINTS_SVC.length).toBeGreaterThan(200);
    expect(DASHBOARD_SVC.length).toBeGreaterThan(500);
    expect(VELOCITY_REPORT.length).toBeGreaterThan(200);
    expect(WORK_QUERY_SVC.length).toBeGreaterThan(500);
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
  const KNOWN_COLUMN_SELECT_REMAINING: readonly string[] = [];

  it("projects-tickets-read.query selects no sprintId and derives no sprintId, because the response contract no longer carries one", () => {
    const content = src("modules/build/core/tickets/projects-tickets-read.query.ts");
    expect(content).not.toMatch(/sprintId\s*:\s*true/);
    expect(content).not.toContain("legacySprintId");
    expect(content).not.toContain("sprintId");
    expect(content).toContain("cycle: {");
  });

  it("the ticket-update path resolves cycleId straight from the request with no sprintId branch, wherever that path now lives", () => {
    const content =
      src("modules/build/core/tickets/projects-tickets-update.service.ts") +
      src("modules/build/core/tickets/apply-ticket-change.ts");
    expect(content).not.toMatch(/sprintId\s*:\s*true/);
    expect(content).not.toContain("sprintId");
    expect(content).toContain("updateData.cycleId");
  });

  it("build-tickets-response.schemas.ts no longer picks sprintId, which is what emptied this allowlist", () => {
    const content = src("modules/build/core/dto/build-tickets-response.schemas.ts");
    expect(content.length).toBeGreaterThan(500);
    expect(content).not.toContain("sprintId");
    expect(content).toContain("cycleId: true");
    expect(content).toContain("cycleId: z.number().int().nullable()");
  });

  it("the column-select scanner is non-vacuous: it flags the exact pick() text that used to hold this allowlist open", () => {
    expect(/sprintId\s*:\s*true/.test("    ticketNumber: true,\n    sprintId: true,\n")).toBe(true);
    expect(/sprintId\s*:\s*true/.test("    ticketNumber: true,\n    cycleId: true,\n")).toBe(false);
  });

  it("no application file carries sprintId: true any more — the allowlist is empty and the floor keeps an empty scan from passing vacuously", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const columnSelectViolators = allFiles
      .filter((f) => /sprintId\s*:\s*true/.test(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f));

    const sortedViolators = [...columnSelectViolators].sort();
    const sortedKnown = [...KNOWN_COLUMN_SELECT_REMAINING].sort();
    expect(sortedViolators).toEqual(sortedKnown);
    expect(sortedKnown).toEqual([]);
  });
});

const WRITE_OBJECT_LITERAL = /\bsprintId\s*:\s*(?:[A-Za-z_$][\w$]*\.)*sprintId\b/;
const WRITE_PROPERTY_ASSIGNMENT = /\.sprintId\s*=\s*[^=]/;

function hasSprintIdWriteForm(content: string): boolean {
  return WRITE_OBJECT_LITERAL.test(content) || WRITE_PROPERTY_ASSIGNMENT.test(content);
}

describe("phase-04 detach invariant: sprintId object-literal WRITE form (the blind spot that let four writes survive)", () => {
  const KNOWN_WRITE_REMAINING: readonly string[] = [].map((p: string) => p.replace(/\//g, sep));

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

  it("the write scanner does not fire on the cycle-derived read form that the deleted bridges used to use", () => {
    expect(hasSprintIdWriteForm("sprintId: row.cycle?.legacySprintId ?? null")).toBe(false);
    expect(hasSprintIdWriteForm("sprintId: cycleId == null ? null : legacyByCycleId.get(cycleId) ?? null")).toBe(false);
    expect(hasSprintIdWriteForm("expect(sprintId === undefined)")).toBe(false);
  });

  it("projects-tickets-create.service takes cycleId straight from the request and mentions no sprint at all", () => {
    const content = src("modules/build/core/tickets/projects-tickets-create.service.ts");
    expect(hasSprintIdWriteForm(content)).toBe(false);
    expect(content).not.toContain("sprintId");
    expect(content).toContain("cycleId: resolvedCycleId");
  });

  it("meetings.service writes cycleId straight from the request and derives no sprintId response field", () => {
    const content = src("modules/build/meetings/meetings.service.ts");
    expect(hasSprintIdWriteForm(content)).toBe(false);
    expect(content).not.toContain("sprintId");
    expect(content).not.toContain("attachSprintIds");
    expect(content).toContain("cycleId: resolvedCycleId");
  });

  it("test-runs.service binds a run to a cycle with no sprintId branch and no derived sprintId field", () => {
    const content = src("modules/build/qa/test-runs.service.ts");
    expect(hasSprintIdWriteForm(content)).toBe(false);
    expect(content).not.toContain("sprintId");
    expect(content).toContain("resolveCycleBinding");
  });

  it("no application file writes sprintId from a request-sourced value any more, which is the precondition a-sprint-cycle-04-detach's data guard cannot check", () => {
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

describe("phase-04 detach invariant: relational `with: { sprint: ... }` form (the blind spot typecheck caught after all three scanners passed)", () => {
  const RELATION_FORM = /sprint:\s*\{/;

  it("the relation scanner is non-vacuous: it flags the exact ticket-detail text that all three earlier scanners missed", () => {
    const preFixDetail = "        sprint: { columns: { id: true, name: true } },";
    expect(preFixDetail).not.toContain("tickets.sprintId");
    expect(preFixDetail).not.toMatch(/sprintId\s*:\s*true/);
    expect(hasSprintIdWriteForm(preFixDetail)).toBe(false);
    expect(RELATION_FORM.test(preFixDetail)).toBe(true);
  });

  it("the relation scanner does not fire on the cycle relation that replaced it", () => {
    expect(RELATION_FORM.test("cycle: { columns: { id: true, name: true } },")).toBe(false);
  });

  it("no application file asks Drizzle for a sprint relation, because that join reads tickets.sprint_id which phase 04 drops", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const violators = allFiles
      .filter((f) => RELATION_FORM.test(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f));

    expect(violators).toEqual([]);
  });

  it("the tickets relation map no longer declares a sprint relation, so the with-key cannot be requested at all", () => {
    const relations = readFileSync(join(BACKEND_SRC, "db", "schema", "build", "relations.ts"), "utf8");
    expect(relations.length).toBeGreaterThan(0);
    expect(relations).toContain("cycle: one(cycles");
    expect(relations).not.toContain("sprint: one(sprints");
  });
});

describe("phase-05 precondition: cycles.legacy_sprint_id has no application reader", () => {
  it("the legacySprintId scanner is non-vacuous: it flags each deleted bridge form verbatim", () => {
    const columnSelect = "        .select({ id: cycles.id, legacySprintId: cycles.legacySprintId })";
    const relationColumn = "        cycle: { columns: { id: true, name: true, legacySprintId: true } },";
    const derivation = "      sprintId: ticket.cycle?.legacySprintId ?? null,";
    const predicate = "        .where(and(eq(cycles.orgId, orgId), eq(cycles.legacySprintId, input.sprintId)))";
    for (const form of [columnSelect, relationColumn, derivation, predicate]) {
      expect(form).toContain("legacySprintId");
    }
    expect("        cycle: { columns: { id: true, name: true } },").not.toContain("legacySprintId");
  });

  it("no application file reads cycles.legacySprintId, so the bridge that produced the sprintId contract field is gone", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const violators = allFiles
      .filter((f) => readFileSync(f, "utf8").includes("legacySprintId"))
      .map((f) => relative(BACKEND_SRC, f));

    expect(violators).toEqual([]);
  });

  it("the cycles table declares no legacySprintId column and no legacy-sprint foreign key, so Drizzle names neither in a SELECT or INSERT", () => {
    const core = readFileSync(join(BACKEND_SRC, "db", "schema", "build", "core.ts"), "utf8");
    expect(core.length).toBeGreaterThan(500);
    expect(core).not.toContain("legacySprintId");
    expect(core).not.toContain("legacy_sprint_id");
    expect(core).not.toContain("fk_cycles_org_legacy_sprint");
  });
});

describe("phase-05 precondition: the build.sprints table has no application reader or writer", () => {
  const SPRINTS_TABLE_FORM =
    /\b(?:from|update|insert|delete)\(sprints\)|query\.sprints\.|\bsprints\.(?:id|orgId|projectId|name|status|goal|startDate|endDate|deletedAt|createdAt|updatedAt)\b/;

  const KNOWN_SPRINTS_TABLE_REMAINING: readonly string[] = [];

  it("the table scanner is non-vacuous: it flags each query form the frozen SprintsService used to carry", () => {
    expect(SPRINTS_TABLE_FORM.test("      .from(sprints)")).toBe(true);
    expect(SPRINTS_TABLE_FORM.test("        .update(sprints)")).toBe(true);
    expect(SPRINTS_TABLE_FORM.test("    const s = await this.db.query.sprints.findFirst({")).toBe(true);
    expect(SPRINTS_TABLE_FORM.test("      .where(and(eq(sprints.orgId, orgId)))")).toBe(true);
    expect(SPRINTS_TABLE_FORM.test('const FROZEN = "Sprints are frozen.";')).toBe(false);
    expect(SPRINTS_TABLE_FORM.test('import { SprintsService } from "./sprints.service";')).toBe(false);
    expect(SPRINTS_TABLE_FORM.test("    return this.sprints.listSprints(u.orgId, projectId);")).toBe(false);
  });

  it("SprintsService itself touches the sprints table nowhere, because every one of its five methods is frozen", () => {
    expect(SPRINTS_TABLE_FORM.test(SPRINTS_SVC)).toBe(false);
    expect(SPRINTS_SVC).not.toContain("legacySprintId");
  });

  it("only the two known-remaining files still touch build.sprints — each is a phase-05 blocker and this allowlist must reach empty before a-sprint-cycle-05-drop.sql runs", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const violators = allFiles
      .filter((f) => SPRINTS_TABLE_FORM.test(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f));

    expect([...violators].sort()).toEqual([...KNOWN_SPRINTS_TABLE_REMAINING].sort());
  });
});

describe("the sprintId field is absent from every Build request and response contract", () => {
  const CONTRACT_FILES = [
    "modules/build/core/dto/ticket.schemas.ts",
    "modules/build/core/dto/build-tickets-response.schemas.ts",
    "modules/build/execution/dto/execution-response.schemas.ts",
    "modules/build/meetings/dto/meetings.schemas.ts",
    "modules/build/meetings/dto/meetings-response.schemas.ts",
    "modules/build/qa/dto/qa.schemas.ts",
    "modules/build/qa/dto/qa-response.schemas.ts",
    "modules/agent-access/dto/agent-response.schemas.ts",
    "modules/ai/core/dto/confirm-action-payloads.schemas.ts",
  ];

  it.each(CONTRACT_FILES)("%s declares no sprintId field", (rel) => {
    const content = src(rel);
    expect(content.length).toBeGreaterThan(200);
    expect(content).not.toContain("sprintId");
  });

  it.each(CONTRACT_FILES.filter((f) => f.includes("build/")))(
    "%s still carries cycleId, so every caller that lost sprintId keeps an iteration identity",
    (rel) => {
      expect(src(rel)).toContain("cycleId");
    },
  );

  it("the only surviving sprintId in a DTO is the frozen route's path parameter, which .strict() requires the route to declare", () => {
    const iterations = src("modules/build/execution/dto/iterations.schemas.ts");
    expect(iterations).toContain("projectAndSprintIdParams");
    expect(iterations).toContain('sprintId: z.coerce.number().int().positive()');
    const withoutParams = iterations.replace(/export const projectAndSprintIdParams[^\n]*\n/, "");
    expect(withoutParams).not.toContain("sprintId");
  });
});

describe("the AI ticket-move action agrees on both halves: proposer and executor", () => {
  const CONFIRM_ACTIONS = src("modules/ai/core/confirm-actions/build-confirm-actions.ts");
  const REGISTRY = src("modules/ai/core/registry/ask-os-tool-registry.ts");

  it("exactly one ticket-move action is defined and it is ticket.moveToCycle", () => {
    expect(CONFIRM_ACTIONS).toContain('action: "ticket.moveToCycle"');
    expect(CONFIRM_ACTIONS).not.toContain("moveToSprint");
    expect(CONFIRM_ACTIONS.match(/action: "ticket\.moveTo\w+"/g)).toEqual(['action: "ticket.moveToCycle"']);
  });

  it("the executor reads cycleId from the payload and calls updateTicket with cycleId, never sprintId", () => {
    expect(CONFIRM_ACTIONS).toContain("{ ticketId, cycleId, cycleName }");
    expect(CONFIRM_ACTIONS).toMatch(/updateTicket(?:FromSystem)?\(actor, null, ticketId, \{ cycleId \}\)/);
    expect(CONFIRM_ACTIONS).not.toContain("sprintId");
  });

  it("the proposer emits the same action key and the same payload field the executor destructures", () => {
    expect(WORK_ACTIONS).toContain('action: "ticket.moveToCycle"');
    expect(WORK_ACTIONS).toContain("cycleId: cycle.id");
    expect(WORK_ACTIONS).not.toContain("sprintId");
  });

  it("the tool registry titles ticket.moveToCycle and no longer offers ticket.moveToSprint to confirm", () => {
    expect(REGISTRY).toContain('"ticket.moveToCycle"');
    expect(REGISTRY).not.toContain("moveToSprint");
  });

  it("no ticket sprint payload schema survives for a half-renamed action to bind to", () => {
    expect(src("modules/ai/core/dto/confirm-action-payloads.schemas.ts")).not.toContain("ticketSprintPayloadSchema");
  });
});
