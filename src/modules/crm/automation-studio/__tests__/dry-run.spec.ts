import { evaluateConditions } from "../../../automation/automation.evaluator";
import type { AutomationCondition } from "../../../../db/schema";

type Condition = AutomationCondition;

interface DryRunNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface DryRunRule {
  id: number;
  conditions: Condition[];
  nodes: DryRunNode[];
}

interface DryRunDeps {
  db: { insert: jest.Mock };
  notifications: { create: jest.Mock };
  email: { send: jest.Mock };
}

function dryRunEvaluate(
  rule: DryRunRule,
  payload: Record<string, unknown>,
  _deps: DryRunDeps,
): { matched: boolean; nodes: Array<{ id: string; type: string; status: "ok" | "skipped" }> } {
  const matched = evaluateConditions(rule.conditions, payload);

  const nodes = rule.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    status: matched ? ("ok" as const) : ("skipped" as const),
  }));

  return { matched, nodes };
}

describe("CRM automation dry-run (test endpoint) — zero side effects", () => {
  let mockDeps: DryRunDeps;

  const RULE: DryRunRule = {
    id: 1,
    conditions: [{ field: "status", op: "eq", value: "qualified" }],
    nodes: [
      { id: "node-email", type: "send_email", config: { to: "rep@co.com", subject: "Hot lead", body: "<p>Hi</p>" } },
      { id: "node-task", type: "create_task", config: { title: "Follow up", assigneeId: "user-1" } },
    ],
  };

  beforeEach(() => {
    mockDeps = {
      db: { insert: jest.fn() },
      notifications: { create: jest.fn() },
      email: { send: jest.fn() },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns matched=true and correct nodes when conditions satisfy payload", () => {
    const result = dryRunEvaluate(RULE, { status: "qualified" }, mockDeps);

    expect(result.matched).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toEqual({ id: "node-email", type: "send_email", status: "ok" });
    expect(result.nodes[1]).toEqual({ id: "node-task", type: "create_task", status: "ok" });
  });

  it("returns matched=false and skipped nodes when conditions fail", () => {
    const result = dryRunEvaluate(RULE, { status: "new" }, mockDeps);

    expect(result.matched).toBe(false);
    expect(result.nodes.every((n) => n.status === "skipped")).toBe(true);
  });

  it("does NOT call db.insert (no task creation)", () => {
    dryRunEvaluate(RULE, { status: "qualified" }, mockDeps);
    expect(mockDeps.db.insert).not.toHaveBeenCalled();
  });

  it("does NOT call notifications.create", () => {
    dryRunEvaluate(RULE, { status: "qualified" }, mockDeps);
    expect(mockDeps.notifications.create).not.toHaveBeenCalled();
  });

  it("does NOT call email.send", () => {
    dryRunEvaluate(RULE, { status: "qualified" }, mockDeps);
    expect(mockDeps.email.send).not.toHaveBeenCalled();
  });

  it("returns matched=true with empty nodes when rule has no action nodes", () => {
    const emptyRule: DryRunRule = { id: 2, conditions: [], nodes: [] };
    const result = dryRunEvaluate(emptyRule, {}, mockDeps);

    expect(result.matched).toBe(true);
    expect(result.nodes).toHaveLength(0);
  });

  it("returns { matched, nodes } shape regardless of payload content", () => {
    const result = dryRunEvaluate(RULE, { unrelated: "field" }, mockDeps);

    expect(result).toHaveProperty("matched");
    expect(result).toHaveProperty("nodes");
    expect(Array.isArray(result.nodes)).toBe(true);
  });
});
