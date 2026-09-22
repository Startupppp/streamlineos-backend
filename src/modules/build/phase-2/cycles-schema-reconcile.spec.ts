import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8").replace(/\r\n/g, "\n");
}

const coreSource = read(REPO_ROOT, "src", "db", "schema", "build", "core.ts");
const ticketCoreSource = read(REPO_ROOT, "src", "db", "schema", "build", "ticket-core.ts");
const eventsSource = read(REPO_ROOT, "src", "db", "schema", "build", "sprint-events.ts");

const cyclesBlock = coreSource.slice(
  coreSource.indexOf("export const cycles = build.table("),
  coreSource.indexOf("export const modules = build.table("),
);

describe("the Drizzle schema declares what the Sprint/Cycle phase SQL created", () => {
  it("finds a non-empty cycles block, so every assertion below can fail", () => {
    expect(cyclesBlock.length).toBeGreaterThan(0);
  });

  it("declares cycles.deleted_at and cycles.goal, the two columns a-sprint-cycle-01-expand.sql adds outside the journal", () => {
    expect(cyclesBlock).toContain(`deletedAt: timestamp("deleted_at", { withTimezone: true }),`);
    expect(cyclesBlock).toContain(`goal: text("goal"),`);
  });

  it("declares the velocity cursor index, so a database built from the schema alone can serve the keyset instead of sorting every cycle", () => {
    expect(cyclesBlock).toContain(`idx_cycles_org_project_velocity_cursor`);
  });

  it("leads the cycles status index with org_id, because the RLS qual is not leakproof and cannot be answered from a project-led index", () => {
    expect(cyclesBlock).toContain(`idx_cycles_org_project_status_live`);
    expect(cyclesBlock).not.toContain(`idx_cycles_project_status_live"`);
  });

  it("declares idx_tickets_org_cycle_live, which the velocity stats query depends on", () => {
    expect(ticketCoreSource).toContain(`idx_tickets_org_cycle_live`);
  });

  it("declares an org-led index on the scope events table, so check:tenant-indexes has a leading tenant index to find", () => {
    expect(eventsSource).toContain(`idx_sprint_scope_events_org_cycle_created`);
  });

  it("keeps both partial indexes predicated on deleted_at, matching the WHERE clause every cycle read now carries", () => {
    const velocity = cyclesBlock.slice(cyclesBlock.indexOf("idx_cycles_org_project_velocity_cursor"));
    const statusLive = cyclesBlock.slice(cyclesBlock.indexOf("idx_cycles_org_project_status_live"));
    expect(velocity).toContain("deletedAt} IS NULL");
    expect(statusLive).toContain("deletedAt} IS NULL");
  });
});
