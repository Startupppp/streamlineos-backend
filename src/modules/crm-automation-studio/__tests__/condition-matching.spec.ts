import { evaluateConditions } from "../../automation/automation.evaluator";
import type { AutomationCondition } from "../../../db/schema";

type Condition = AutomationCondition;

describe("CRM condition matching — evaluateConditions", () => {
  it("eq: matches when payload field equals value", () => {
    const conditions: Condition[] = [{ field: "status", op: "eq", value: "open" }];
    expect(evaluateConditions(conditions, { status: "open" })).toBe(true);
  });

  it("eq: does not match when payload field differs", () => {
    const conditions: Condition[] = [{ field: "status", op: "eq", value: "open" }];
    expect(evaluateConditions(conditions, { status: "closed" })).toBe(false);
  });

  it("neq: matches when payload field differs from value", () => {
    const conditions: Condition[] = [{ field: "status", op: "neq", value: "closed" }];
    expect(evaluateConditions(conditions, { status: "open" })).toBe(true);
  });

  it("neq: does not match when payload field equals value", () => {
    const conditions: Condition[] = [{ field: "status", op: "neq", value: "closed" }];
    expect(evaluateConditions(conditions, { status: "closed" })).toBe(false);
  });

  it("gt: matches when numeric payload field is greater than value", () => {
    const conditions: Condition[] = [{ field: "score", op: "gt", value: 50 }];
    expect(evaluateConditions(conditions, { score: 75 })).toBe(true);
  });

  it("gt: does not match when numeric payload field is less than value", () => {
    const conditions: Condition[] = [{ field: "score", op: "gt", value: 50 }];
    expect(evaluateConditions(conditions, { score: 25 })).toBe(false);
  });

  it("lt: matches when numeric payload field is less than value", () => {
    const conditions: Condition[] = [{ field: "score", op: "lt", value: 50 }];
    expect(evaluateConditions(conditions, { score: 30 })).toBe(true);
  });

  it("lt: does not match when numeric payload field is greater than value", () => {
    const conditions: Condition[] = [{ field: "score", op: "lt", value: 50 }];
    expect(evaluateConditions(conditions, { score: 80 })).toBe(false);
  });

  it("contains: matches when string field contains the substring (case-insensitive)", () => {
    const conditions: Condition[] = [{ field: "title", op: "contains", value: "enterprise" }];
    expect(evaluateConditions(conditions, { title: "Enterprise Deal Q3" })).toBe(true);
  });

  it("contains: does not match when string field lacks the substring", () => {
    const conditions: Condition[] = [{ field: "title", op: "contains", value: "enterprise" }];
    expect(evaluateConditions(conditions, { title: "SMB Deal Q3" })).toBe(false);
  });

  it("in (via eq on stringified array member): returns false for unknown op gracefully", () => {
    const conditions = [{ field: "stage", op: "in" as never, value: ["won", "lost"] }];
    expect(evaluateConditions(conditions, { stage: "won" })).toBe(false);
  });

  it("changed_to: matches when payload.data._prev differs from current field value", () => {
    const conditions: Condition[] = [{ field: "status", op: "eq", value: "qualified" }];
    const payload = {
      status: "qualified",
      "data._prev": "new",
    };
    expect(evaluateConditions(conditions, payload)).toBe(true);
  });

  it("changed_to: does not match when current value is still the previous value", () => {
    const conditions: Condition[] = [{ field: "status", op: "eq", value: "qualified" }];
    const payload = { status: "new" };
    expect(evaluateConditions(conditions, payload)).toBe(false);
  });

  it("multiple AND conditions: all must match — passes when all do", () => {
    const conditions: Condition[] = [
      { field: "status", op: "eq", value: "open" },
      { field: "score", op: "gt", value: 40 },
    ];
    expect(evaluateConditions(conditions, { status: "open", score: 85 })).toBe(true);
  });

  it("multiple AND conditions: fails when any one does not match", () => {
    const conditions: Condition[] = [
      { field: "status", op: "eq", value: "open" },
      { field: "score", op: "gt", value: 40 },
    ];
    expect(evaluateConditions(conditions, { status: "open", score: 10 })).toBe(false);
  });

  it("empty conditions array → always returns true", () => {
    expect(evaluateConditions([], { anything: "here" })).toBe(true);
  });

  it("missing field → does not match an eq condition", () => {
    const conditions: Condition[] = [{ field: "nonExistent", op: "eq", value: "x" }];
    expect(evaluateConditions(conditions, {})).toBe(false);
  });
});
