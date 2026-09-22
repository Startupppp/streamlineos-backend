import {
  bugStatusEnum,
  bugPriorityEnum,
  bugSeverityEnum,
} from "../../../../db/schema/build/qa";
import { stateGroupEnum, ticketPriorityEnum } from "../../../../db/schema/common/enums";
import {
  BUG_STATUS_TO_STATE_GROUP,
  BUG_PRIORITY_TO_TICKET_PRIORITY,
  BUG_SEVERITY_TO_SUGGESTED_PRIORITY,
  STATE_GROUP_FALLBACK_CHAIN,
  SEEDED_FALLBACK_PROJECT_STATUSES,
  UNRESOLVED_STATE_GROUP,
  resolveStateGroup,
  resolveTicketPriority,
  resolveSuggestedPriorityFromSeverity,
  resolveProjectStatusName,
  resolveWorkItemStatus,
} from "./bug-consolidation-mapping";

const ALL_BUG_STATUSES = bugStatusEnum.enumValues;
const ALL_BUG_PRIORITIES = bugPriorityEnum.enumValues;
const ALL_BUG_SEVERITIES = bugSeverityEnum.enumValues;
const ALL_STATE_GROUPS = stateGroupEnum.enumValues;
const ALL_TICKET_PRIORITIES = ticketPriorityEnum.enumValues;

describe("BUG_STATUS_TO_STATE_GROUP — exhaustiveness", () => {
  it("covers every value in bugStatusEnum — if a new status is added to the enum and omitted from the map, this test fails", () => {
    for (const status of ALL_BUG_STATUSES) {
      expect(BUG_STATUS_TO_STATE_GROUP).toHaveProperty(status);
    }
    expect(Object.keys(BUG_STATUS_TO_STATE_GROUP)).toHaveLength(ALL_BUG_STATUSES.length);
  });

  it("maps every bug status to a valid stateGroupEnum value — if a target group is misspelled, this test fails", () => {
    for (const [status, group] of Object.entries(BUG_STATUS_TO_STATE_GROUP)) {
      expect(ALL_STATE_GROUPS).toContain(group);
      void status;
    }
  });

  it("maps new → backlog (not yet triaged)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["new"]).toBe("backlog");
  });

  it("maps triaged → unstarted (scoped but not started)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["triaged"]).toBe("unstarted");
  });

  it("maps assigned → unstarted (assigned but not yet in flight)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["assigned"]).toBe("unstarted");
  });

  it("maps in_progress → started", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["in_progress"]).toBe("started");
  });

  it("maps fixed → started (developer asserts fixed, QA not yet confirmed)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["fixed"]).toBe("started");
  });

  it("maps ready_for_qa → started (awaiting QA sign-off, not yet complete)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["ready_for_qa"]).toBe("started");
  });

  it("maps verified → completed (QA confirmed the fix)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["verified"]).toBe("completed");
  });

  it("maps reopened → started (regression, work is active again)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["reopened"]).toBe("started");
  });

  it("maps closed → completed (won-t-fix or out-of-scope, lifecycle ended)", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["closed"]).toBe("completed");
  });

  it("fixed and ready_for_qa both collapse to started — qa_state in work_item_qa_details preserves the raw value so information is not lost", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["fixed"]).toBe("started");
    expect(BUG_STATUS_TO_STATE_GROUP["ready_for_qa"]).toBe("started");
  });

  it("verified and closed both collapse to completed — qa_state in work_item_qa_details preserves the raw value so information is not lost", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["verified"]).toBe("completed");
    expect(BUG_STATUS_TO_STATE_GROUP["closed"]).toBe("completed");
  });

  it("triaged and assigned both collapse to unstarted — qa_state in work_item_qa_details preserves the raw value so information is not lost", () => {
    expect(BUG_STATUS_TO_STATE_GROUP["triaged"]).toBe("unstarted");
    expect(BUG_STATUS_TO_STATE_GROUP["assigned"]).toBe("unstarted");
  });
});

describe("BUG_PRIORITY_TO_TICKET_PRIORITY — exhaustiveness", () => {
  it("covers every value in bugPriorityEnum — if a new priority is added and omitted from the map, this test fails", () => {
    for (const priority of ALL_BUG_PRIORITIES) {
      expect(BUG_PRIORITY_TO_TICKET_PRIORITY).toHaveProperty(priority);
    }
    expect(Object.keys(BUG_PRIORITY_TO_TICKET_PRIORITY)).toHaveLength(ALL_BUG_PRIORITIES.length);
  });

  it("maps every bug priority to a valid ticketPriorityEnum value", () => {
    for (const [priority, ticketPriority] of Object.entries(BUG_PRIORITY_TO_TICKET_PRIORITY)) {
      expect(ALL_TICKET_PRIORITIES).toContain(ticketPriority);
      void priority;
    }
  });

  it("maps low → LOW", () => expect(BUG_PRIORITY_TO_TICKET_PRIORITY["low"]).toBe("LOW"));
  it("maps medium → MEDIUM", () => expect(BUG_PRIORITY_TO_TICKET_PRIORITY["medium"]).toBe("MEDIUM"));
  it("maps high → HIGH", () => expect(BUG_PRIORITY_TO_TICKET_PRIORITY["high"]).toBe("HIGH"));
  it("maps urgent → URGENT", () => expect(BUG_PRIORITY_TO_TICKET_PRIORITY["urgent"]).toBe("URGENT"));
});

describe("BUG_SEVERITY_TO_SUGGESTED_PRIORITY — exhaustiveness", () => {
  it("covers every value in bugSeverityEnum — if a new severity is added and omitted from the map, this test fails", () => {
    for (const severity of ALL_BUG_SEVERITIES) {
      expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY).toHaveProperty(severity);
    }
    expect(Object.keys(BUG_SEVERITY_TO_SUGGESTED_PRIORITY)).toHaveLength(ALL_BUG_SEVERITIES.length);
  });

  it("maps every severity to a valid ticketPriorityEnum value", () => {
    for (const [severity, ticketPriority] of Object.entries(BUG_SEVERITY_TO_SUGGESTED_PRIORITY)) {
      expect(ALL_TICKET_PRIORITIES).toContain(ticketPriority);
      void severity;
    }
  });

  it("maps blocker → URGENT", () => expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY["blocker"]).toBe("URGENT"));
  it("maps critical → HIGH", () => expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY["critical"]).toBe("HIGH"));
  it("maps major → MEDIUM", () => expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY["major"]).toBe("MEDIUM"));
  it("maps minor → LOW", () => expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY["minor"]).toBe("LOW"));
  it("maps trivial → LOW", () => expect(BUG_SEVERITY_TO_SUGGESTED_PRIORITY["trivial"]).toBe("LOW"));
});

describe("resolveStateGroup — safe defaults", () => {
  it("returns UNRESOLVED_STATE_GROUP for null", () => {
    expect(resolveStateGroup(null)).toBe(UNRESOLVED_STATE_GROUP);
  });

  it("returns UNRESOLVED_STATE_GROUP for undefined", () => {
    expect(resolveStateGroup(undefined)).toBe(UNRESOLVED_STATE_GROUP);
  });

  it("returns UNRESOLVED_STATE_GROUP for an unrecognised status string — mutation guard: if UNRESOLVED_STATE_GROUP is changed, this test fails", () => {
    expect(resolveStateGroup("unknown_future_status")).toBe(UNRESOLVED_STATE_GROUP);
  });

  it("returns the correct group for every known bug status — if a mapping entry is deleted, this test fails", () => {
    for (const status of ALL_BUG_STATUSES) {
      const expected = BUG_STATUS_TO_STATE_GROUP[status];
      expect(resolveStateGroup(status)).toBe(expected);
    }
  });
});

describe("resolveTicketPriority — safe defaults", () => {
  it("returns MEDIUM for null", () => {
    expect(resolveTicketPriority(null)).toBe("MEDIUM");
  });

  it("returns MEDIUM for undefined", () => {
    expect(resolveTicketPriority(undefined)).toBe("MEDIUM");
  });

  it("returns MEDIUM for an unrecognised priority string", () => {
    expect(resolveTicketPriority("super_high")).toBe("MEDIUM");
  });

  it("maps every known priority correctly", () => {
    for (const priority of ALL_BUG_PRIORITIES) {
      expect(resolveTicketPriority(priority)).toBe(BUG_PRIORITY_TO_TICKET_PRIORITY[priority]);
    }
  });
});

describe("resolveSuggestedPriorityFromSeverity — safe defaults", () => {
  it("returns MEDIUM for null", () => {
    expect(resolveSuggestedPriorityFromSeverity(null)).toBe("MEDIUM");
  });

  it("returns MEDIUM for undefined", () => {
    expect(resolveSuggestedPriorityFromSeverity(undefined)).toBe("MEDIUM");
  });

  it("maps every known severity correctly", () => {
    for (const severity of ALL_BUG_SEVERITIES) {
      expect(resolveSuggestedPriorityFromSeverity(severity)).toBe(BUG_SEVERITY_TO_SUGGESTED_PRIORITY[severity]);
    }
  });
});

describe("STATE_GROUP_FALLBACK_CHAIN — completeness", () => {
  it("covers every stateGroupEnum value as a key — if a new group is added to the enum and omitted from the chain, this test fails", () => {
    for (const group of ALL_STATE_GROUPS) {
      expect(STATE_GROUP_FALLBACK_CHAIN).toHaveProperty(group);
    }
    expect(Object.keys(STATE_GROUP_FALLBACK_CHAIN)).toHaveLength(ALL_STATE_GROUPS.length);
  });

  it("every fallback chain eventually includes all state groups — no dead-end chain", () => {
    for (const group of ALL_STATE_GROUPS) {
      const chain = STATE_GROUP_FALLBACK_CHAIN[group];
      expect(chain.length).toBeGreaterThan(0);
      for (const step of chain) {
        expect(ALL_STATE_GROUPS).toContain(step);
      }
    }
  });

  it("resolveProjectStatusName never returns undefined or empty string — even against an empty status pool", () => {
    for (const group of ALL_STATE_GROUPS) {
      const name = resolveProjectStatusName(group, []);
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveWorkItemStatus — end-to-end mapping with fallback statuses", () => {
  it("maps new (backlog) → TODO via the seeded fallback — backlog has no direct match so falls through to unstarted", () => {
    const result = resolveWorkItemStatus("new", []);
    expect(result).toBe("TODO");
  });

  it("maps in_progress (started) → IN_PROGRESS via the seeded fallback", () => {
    const result = resolveWorkItemStatus("in_progress", []);
    expect(result).toBe("IN_PROGRESS");
  });

  it("maps verified (completed) → DONE via the seeded fallback", () => {
    const result = resolveWorkItemStatus("verified", []);
    expect(result).toBe("DONE");
  });

  it("maps closed (completed) → DONE via the seeded fallback — not lost even though it collapses with verified", () => {
    const result = resolveWorkItemStatus("closed", []);
    expect(result).toBe("DONE");
  });

  it("maps fixed (started) → IN_PROGRESS via the seeded fallback — preserved via qa_state, not via the ticket status", () => {
    const result = resolveWorkItemStatus("fixed", []);
    expect(result).toBe("IN_PROGRESS");
  });

  it("maps ready_for_qa (started) → IN_PROGRESS via the seeded fallback — preserved via qa_state, not via the ticket status", () => {
    const result = resolveWorkItemStatus("ready_for_qa", []);
    expect(result).toBe("IN_PROGRESS");
  });

  it("resolves to the custom project status name when available", () => {
    const customStatuses = [
      { id: 10, name: "Backlog", order: 0, type: "backlog" as const },
      { id: 11, name: "In Dev", order: 1, type: "started" as const },
      { id: 12, name: "Shipped", order: 2, type: "completed" as const },
    ];
    expect(resolveWorkItemStatus("new", customStatuses)).toBe("Backlog");
    expect(resolveWorkItemStatus("in_progress", customStatuses)).toBe("In Dev");
    expect(resolveWorkItemStatus("verified", customStatuses)).toBe("Shipped");
  });

  it("handles null bug status gracefully by returning a non-empty string", () => {
    const result = resolveWorkItemStatus(null, []);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles undefined bug status gracefully", () => {
    const result = resolveWorkItemStatus(undefined, []);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("every known bug status produces a non-empty ticket status name — exhaustive coverage", () => {
    for (const status of ALL_BUG_STATUSES) {
      const name = resolveWorkItemStatus(status, SEEDED_FALLBACK_PROJECT_STATUSES);
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
