import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import {
  bugPriorityEnum,
  bugSeverityEnum,
  bugStatusEnum,
  bugs,
  testRunResults,
} from "../../../db/schema/build/qa";
import { tickets } from "../../../db/schema/build/ticket-core";
import { stateGroupEnum, ticketPriorityEnum } from "../../../db/schema/common/enums";
import { DEFAULT_PROJECT_STATUSES } from "../core/lib/default-statuses";
import {
  BUG_COLUMN_DISPOSITIONS,
  BUG_PRIORITY_TO_TICKET_PRIORITY,
  BUG_SEVERITY_TO_SUGGESTED_PRIORITY,
  BUG_STATUS_TO_STATE_GROUP,
  STATE_GROUP_FALLBACK_CHAIN,
  UNRESOLVED_STATE_GROUP,
  UNRESOLVED_TICKET_PRIORITY,
  resolveProjectStatusName,
  resolveStateGroup,
  resolveSuggestedPriorityFromSeverity,
  resolveTicketPriority,
  resolveWorkItemStatus,
  type ProjectStatusCandidate,
  type StateGroup,
} from "../qa/phase-2/bug-consolidation-mapping";

const SRC_ROOT = join(__dirname, "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), "utf8");
}

function dbColumnNames(table: Record<string, unknown>): string[] {
  return Object.values(getTableColumns(table as never))
    .map((column) => (column as { name: string }).name)
    .sort();
}

const BUG_COLUMNS = dbColumnNames(bugs as unknown as Record<string, unknown>);
const TICKET_COLUMNS = dbColumnNames(tickets as unknown as Record<string, unknown>);

describe("bug_status to canonical state-group mapping", () => {
  it("covers every value of the real bug_status enum read from the schema", () => {
    expect(bugStatusEnum.enumValues.length).toBeGreaterThan(0);
    for (const value of bugStatusEnum.enumValues) {
      expect(Object.prototype.hasOwnProperty.call(BUG_STATUS_TO_STATE_GROUP, value)).toBe(true);
    }
  });

  it("declares no mapping key that is not a real bug_status value", () => {
    const real = new Set<string>(bugStatusEnum.enumValues);
    for (const key of Object.keys(BUG_STATUS_TO_STATE_GROUP)) {
      expect(real.has(key)).toBe(true);
    }
  });

  it("only targets values of the real state_group enum", () => {
    const groups = new Set<string>(stateGroupEnum.enumValues);
    for (const target of Object.values(BUG_STATUS_TO_STATE_GROUP)) {
      expect(groups.has(target)).toBe(true);
    }
  });

  it("resolves NULL and undefined without throwing and without inventing a terminal state", () => {
    expect(resolveStateGroup(null)).toBe(UNRESOLVED_STATE_GROUP);
    expect(resolveStateGroup(undefined)).toBe(UNRESOLVED_STATE_GROUP);
    expect(["backlog", "unstarted"]).toContain(UNRESOLVED_STATE_GROUP);
  });

  it("resolves an unrecognised status to the same non-terminal group as NULL", () => {
    expect(resolveStateGroup("a_value_no_enum_has")).toBe(UNRESOLVED_STATE_GROUP);
  });

  it("returns the identical group on repeated calls for every enum value", () => {
    for (const value of bugStatusEnum.enumValues) {
      const first = resolveStateGroup(value);
      const second = resolveStateGroup(value);
      const third = resolveStateGroup(value);
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });

  it("never marks an unverified defect as completed", () => {
    const completed = bugStatusEnum.enumValues.filter(
      (value) => BUG_STATUS_TO_STATE_GROUP[value] === "completed",
    );
    expect(completed.sort()).toEqual(["closed", "verified"]);
  });
});

describe("state-group fallback chain", () => {
  it("defines a chain for every real state_group value", () => {
    for (const group of stateGroupEnum.enumValues) {
      expect(Object.prototype.hasOwnProperty.call(STATE_GROUP_FALLBACK_CHAIN, group)).toBe(true);
    }
  });

  it("makes each chain a total permutation of the real state_group enum", () => {
    const expected = [...stateGroupEnum.enumValues].sort();
    for (const group of stateGroupEnum.enumValues) {
      const chain = STATE_GROUP_FALLBACK_CHAIN[group as StateGroup];
      expect([...chain].sort()).toEqual(expected);
      expect(chain[0]).toBe(group);
    }
  });

  it("puts cancelled last for every non-cancelled target so no defect is auto-cancelled", () => {
    for (const group of stateGroupEnum.enumValues) {
      if (group === "cancelled") continue;
      const chain = STATE_GROUP_FALLBACK_CHAIN[group as StateGroup];
      expect(chain[chain.length - 1]).toBe("cancelled");
    }
  });
});

describe("per-project status resolution", () => {
  const seeded: ProjectStatusCandidate[] = DEFAULT_PROJECT_STATUSES.map((status, index) => ({
    id: index + 1,
    name: status.name,
    order: status.order,
    type: status.type,
  }));

  it("resolves every bug_status value against the seeded default project states", () => {
    for (const value of bugStatusEnum.enumValues) {
      const name = resolveWorkItemStatus(value, seeded);
      expect(seeded.map((s) => s.name)).toContain(name);
    }
  });

  it("is order-independent for the same candidate set", () => {
    const shuffled = [seeded[3]!, seeded[0]!, seeded[2]!, seeded[1]!];
    for (const value of bugStatusEnum.enumValues) {
      expect(resolveWorkItemStatus(value, shuffled)).toBe(resolveWorkItemStatus(value, seeded));
    }
  });

  it("breaks an order tie on id so two same-order states cannot flip the result", () => {
    const tied: ProjectStatusCandidate[] = [
      { id: 91, name: "STARTED_B", order: 5, type: "started" },
      { id: 12, name: "STARTED_A", order: 5, type: "started" },
    ];
    expect(resolveProjectStatusName("started", tied)).toBe("STARTED_A");
    expect(resolveProjectStatusName("started", [...tied].reverse())).toBe("STARTED_A");
  });

  it("treats a custom state with a NULL type as unstarted rather than skipping it", () => {
    const untyped: ProjectStatusCandidate[] = [
      { id: 4, name: "UNTYPED", order: 0, type: null },
      { id: 5, name: "SHIPPED", order: 1, type: "completed" },
    ];
    expect(resolveProjectStatusName("unstarted", untyped)).toBe("UNTYPED");
  });

  it("falls back down the chain when the project models no state of the target group", () => {
    const noCompleted: ProjectStatusCandidate[] = [
      { id: 1, name: "OPEN", order: 0, type: "unstarted" },
      { id: 2, name: "WORKING", order: 1, type: "started" },
    ];
    expect(resolveProjectStatusName("completed", noCompleted)).toBe("WORKING");
  });

  it("returns a seeded default name when the project has zero project_statuses rows", () => {
    const seededNames = DEFAULT_PROJECT_STATUSES.map((s) => s.name);
    for (const value of bugStatusEnum.enumValues) {
      expect(seededNames).toContain(resolveWorkItemStatus(value, []));
    }
  });

  it("is total over every state_group target for a single-state project", () => {
    const single: ProjectStatusCandidate[] = [{ id: 7, name: "ONLY", order: 0, type: "cancelled" }];
    for (const group of stateGroupEnum.enumValues) {
      expect(resolveProjectStatusName(group as StateGroup, single)).toBe("ONLY");
    }
  });
});

describe("priority mapping", () => {
  it("covers every value of the real bug_priority enum", () => {
    for (const value of bugPriorityEnum.enumValues) {
      expect(Object.prototype.hasOwnProperty.call(BUG_PRIORITY_TO_TICKET_PRIORITY, value)).toBe(
        true,
      );
    }
  });

  it("only targets values of the real ticket_priority enum", () => {
    const targets = new Set<string>(ticketPriorityEnum.enumValues);
    for (const value of Object.values(BUG_PRIORITY_TO_TICKET_PRIORITY)) {
      expect(targets.has(value)).toBe(true);
    }
  });

  it("is injective so no two bug priorities collapse onto one ticket priority", () => {
    const mapped = Object.values(BUG_PRIORITY_TO_TICKET_PRIORITY);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("resolves NULL and an unknown value to the ticket_priority column default", () => {
    expect(resolveTicketPriority(null)).toBe(UNRESOLVED_TICKET_PRIORITY);
    expect(resolveTicketPriority(undefined)).toBe(UNRESOLVED_TICKET_PRIORITY);
    expect(resolveTicketPriority("catastrophic")).toBe(UNRESOLVED_TICKET_PRIORITY);
    expect(ticketPriorityEnum.enumValues).toContain(UNRESOLVED_TICKET_PRIORITY);
  });
});

describe("severity mapping", () => {
  it("covers every value of the real bug_severity enum", () => {
    for (const value of bugSeverityEnum.enumValues) {
      expect(Object.prototype.hasOwnProperty.call(BUG_SEVERITY_TO_SUGGESTED_PRIORITY, value)).toBe(
        true,
      );
    }
  });

  it("only targets values of the real ticket_priority enum", () => {
    const targets = new Set<string>(ticketPriorityEnum.enumValues);
    for (const value of Object.values(BUG_SEVERITY_TO_SUGGESTED_PRIORITY)) {
      expect(targets.has(value)).toBe(true);
    }
  });

  it("resolves NULL and an unknown value deterministically", () => {
    expect(resolveSuggestedPriorityFromSeverity(null)).toBe(UNRESOLVED_TICKET_PRIORITY);
    expect(resolveSuggestedPriorityFromSeverity(undefined)).toBe(UNRESOLVED_TICKET_PRIORITY);
    expect(resolveSuggestedPriorityFromSeverity("showstopper")).toBe(UNRESOLVED_TICKET_PRIORITY);
  });

  it("is a suggestion only, so the canonical priority still comes from bug.priority", () => {
    expect(resolveSuggestedPriorityFromSeverity("blocker")).toBe("URGENT");
    expect(resolveTicketPriority("low")).toBe("LOW");
  });
});

describe("column coverage of the consolidation design", () => {
  it("assigns a disposition to every real build.bugs column", () => {
    for (const column of BUG_COLUMNS) {
      expect(Object.prototype.hasOwnProperty.call(BUG_COLUMN_DISPOSITIONS, column)).toBe(true);
    }
  });

  it("declares no disposition for a column build.bugs does not have", () => {
    const real = new Set(BUG_COLUMNS);
    for (const key of Object.keys(BUG_COLUMN_DISPOSITIONS)) {
      expect(real.has(key)).toBe(true);
    }
  });

  it("gives every disposition a destination and a reason", () => {
    for (const [column, disposition] of Object.entries(BUG_COLUMN_DISPOSITIONS)) {
      expect(disposition.destination.length).toBeGreaterThan(0);
      expect(disposition.reason.length).toBeGreaterThan(0);
      expect(column.length).toBeGreaterThan(0);
    }
  });

  it("drops no column silently", () => {
    const dropped = Object.entries(BUG_COLUMN_DISPOSITIONS).filter(
      ([, disposition]) => disposition.target === "drop",
    );
    expect(dropped).toEqual([]);
  });

  it("routes every shared column other than the surrogate key onto the canonical work item", () => {
    const ticketColumns = new Set(TICKET_COLUMNS);
    const shared = BUG_COLUMNS.filter((column) => ticketColumns.has(column) && column !== "id");
    expect(shared).toEqual([
      "assignee_membership_id",
      "created_at",
      "deleted_at",
      "description",
      "org_id",
      "priority",
      "project_id",
      "reporter_id",
      "status",
      "title",
      "updated_at",
    ]);
    for (const column of shared) {
      expect(BUG_COLUMN_DISPOSITIONS[column]!.target).toBe("work_item");
    }
    expect(BUG_COLUMN_DISPOSITIONS["id"]!.target).toBe("identity_map");
  });

  it("keeps every relationship-bearing QA column as a sidecar column rather than JSONB", () => {
    const relationshipColumns = [
      "affected_release_id",
      "fixed_release_id",
      "linked_test_case_id",
      "qa_owner_membership_id",
    ];
    for (const column of relationshipColumns) {
      expect(BUG_COLUMNS).toContain(column);
      expect(BUG_COLUMN_DISPOSITIONS[column]!.target).toBe("qa_sidecar");
      expect(BUG_COLUMN_DISPOSITIONS[column]!.destination).toMatch(
        /^build\.work_item_qa_details\./,
      );
    }
  });
});

describe("dual-identity tripwire", () => {
  it("still has a build.bugs table declared separately from build.tickets", () => {
    expect(BUG_COLUMNS.length).toBeGreaterThan(0);
    expect(readSource("db/schema/build/qa.ts")).toContain('build.table("bugs"');
  });

  it("still carries a second per-project human key alongside ticket_number", () => {
    expect(BUG_COLUMNS).toContain("bug_number");
    expect(TICKET_COLUMNS).toContain("ticket_number");
    expect(readSource("db/schema/build/qa.ts")).toContain("uq_bugs_project_number");
  });

  it("still allocates bug numbers by MAX+1 instead of the project_ticket_counters allocator", () => {
    const bugsService = readSource("modules/build/qa/bugs.service.ts");
    const testRuns = readSource("modules/build/qa/test-runs.service.ts");
    expect(bugsService).toContain("pg_advisory_xact_lock");
    expect(bugsService).toContain("MAX(");
    expect(bugsService).not.toContain("allocateTicketNumbers");
    expect(testRuns).toContain("pg_advisory_xact_lock");
    expect(testRuns).not.toContain("allocateTicketNumbers");
  });

  it("still lets a test run insert a defect straight into build.bugs", () => {
    expect(readSource("modules/build/qa/test-runs.service.ts")).toContain(".insert(bugs)");
  });

  it("still has no canonical comment, attachment, label or watcher path for a defect", () => {
    const collaboration = readSource("db/schema/build/ticket-collaboration.ts");
    expect(collaboration).toContain('"ticket_attachments"');
    expect(collaboration).toContain('"ticket_labels"');
    expect(collaboration).toContain('"ticket_watchers"');
    expect(collaboration).not.toContain("bug_comments");
    expect(collaboration).not.toContain("bug_attachments");
    expect(collaboration).not.toContain("bug_watchers");
  });

  it("still points test_run_results evidence at a bug id rather than a work item id", () => {
    const resultColumns = dbColumnNames(testRunResults as unknown as Record<string, unknown>);
    expect(resultColumns).toContain("linked_bug_id");
    expect(resultColumns).not.toContain("linked_work_item_id");
  });

  it("still has no work_item_qa_details sidecar and no bug_work_item_map", () => {
    const qaSchema = readSource("db/schema/build/qa.ts");
    expect(qaSchema).not.toContain("work_item_qa_details");
    expect(qaSchema).not.toContain("bug_work_item_map");
  });

  it("still gates defects on build:bugs keys that are disjoint from build:tickets keys", () => {
    const controller = readSource("modules/build/qa/bugs.controller.ts");
    expect(controller).toContain('RequirePermission("build:bugs:view")');
    expect(controller).toContain('RequirePermission("build:bugs:create")');
    expect(controller).toContain('RequirePermission("build:bugs:update")');
    expect(controller).toContain('RequirePermission("build:bugs:delete")');
    expect(controller).not.toContain("build:tickets:");
  });
});

describe("recorded facts the design depends on", () => {
  it("records the real bug_status cardinality", () => {
    expect(bugStatusEnum.enumValues).toEqual([
      "new",
      "triaged",
      "assigned",
      "in_progress",
      "fixed",
      "ready_for_qa",
      "verified",
      "reopened",
      "closed",
    ]);
  });

  it("records that the canonical status model is a per-project table, not a pg enum", () => {
    const ticketCore = readSource("db/schema/build/ticket-core.ts");
    expect(ticketCore).toContain('status: text("status").notNull().default("TODO")');
    expect(ticketCore).toContain("fk_tickets_status");
    expect(ticketCore).toContain("projectStatuses.name");
  });

  it("records the real count of bugs columns the canonical ticket lacks", () => {
    const ticketColumns = new Set(TICKET_COLUMNS);
    const missing = BUG_COLUMNS.filter((column) => !ticketColumns.has(column));
    expect(missing).toEqual([
      "actual_result",
      "affected_release_id",
      "browser_device",
      "bug_number",
      "created_by",
      "environment",
      "expected_result",
      "fixed_release_id",
      "linked_test_case_id",
      "linked_ticket_id",
      "qa_owner_id",
      "qa_owner_membership_id",
      "reopen_count",
      "severity",
      "steps_to_reproduce",
    ]);
    expect(missing).toHaveLength(15);
  });

  it("records that bugs has no optimistic-concurrency version column while tickets does", () => {
    expect(TICKET_COLUMNS).toContain("version");
    expect(BUG_COLUMNS).not.toContain("version");
  });
});
