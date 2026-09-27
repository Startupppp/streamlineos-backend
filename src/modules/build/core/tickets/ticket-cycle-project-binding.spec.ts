import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname);

function read(name: string): string {
  return readFileSync(join(CORE, name), "utf8");
}

const CREATE = read("projects-tickets-create.service.ts");
const UPDATE =
  read("projects-tickets-update.service.ts") + read("apply-ticket-change.ts");
const BULK = read("build-ticket-bulk-mutation.ts");

const PROJECT_SCOPED_CYCLE_LOOKUP = /eq\(cycles\.projectId,\s*(?:projectId|body\.projectId)\)/;

describe("a ticket cannot be bound to a cycle belonging to another project in the same organization", () => {
  it("the three sources agree that a cycle lookup is project-scoped, not merely org-scoped, because fk_tickets_org_cycle enforces org and nothing enforces project", () => {
    for (const [name, source] of [
      ["create", CREATE],
      ["update", UPDATE],
      ["bulk", BULK],
    ] as const) {
      expect(source.length).toBeGreaterThan(500);
      expect([name, PROJECT_SCOPED_CYCLE_LOOKUP.test(source)]).toEqual([name, true]);
    }
  });

  it("the single-ticket create path rejects an out-of-project cycle rather than writing it", () => {
    expect(CREATE).toContain("Cycle not found in this project");
    expect(CREATE).toContain("eq(cycles.orgId, u.orgId)");
  });

  it("the single-ticket update path rejects an out-of-project cycle rather than writing it, read across both files the write spans since the consolidation moved the cycle lookup out of the orchestrator", () => {
    expect(UPDATE).toContain("Cycle not found in this project");
    expect(UPDATE).toContain("eq(cycles.orgId, orgId)");
  });

  it("reads the update path as orchestrator plus change module because the orchestrator writes no cycle itself, so scanning it alone reports a guard as missing when it is merely elsewhere", () => {
    const orchestrator = read("projects-tickets-update.service.ts");

    expect(orchestrator).toContain("applyTicketChange");
    expect(orchestrator).not.toContain("cycles.projectId");
    expect(read("apply-ticket-change.ts")).toContain("eq(cycles.projectId, projectId)");
  });

  it("the update path skips the check only when projectId is null, which is the system-job shape that carries no project to scope to", () => {
    expect(UPDATE).toContain("projectId !== null");
  });

  it("the bulk path that already had the check still has it, so this invariant is not regressing in the one place it was honoured", () => {
    expect(BULK).toContain("Cycle not found in this project");
  });

  it("the sibling epic reference on the create path is project-scoped too, which is the precedent the cycle check follows", () => {
    expect(CREATE).toContain("Epic ticket not found in this project");
    expect(CREATE).toMatch(/eq\(tickets\.projectId,\s*projectId\)/);
  });
});
