import {
  actThresholdFor,
  buildDecision,
  capRows,
  capText,
  hasEligibleContext,
  redactForModel,
  reversibilityFor,
  shouldAct,
} from "./decision-record";
import { DECISION_KINDS } from "../../db/schema/crm/autonomous-decisions";

describe("reversibility", () => {
  it("classifies every kind, so none is left unclassified at runtime", () => {
    for (const kind of DECISION_KINDS) expect(reversibilityFor(kind)).toBeTruthy();
  });

  it("treats a sent quote as held rather than instantly reversible", () => {
    expect(reversibilityFor("quote.sent")).toBe("hold");
  });

  it("treats record writes as instantly reversible", () => {
    expect(reversibilityFor("stage.advanced")).toBe("instant");
    expect(reversibilityFor("task.extracted")).toBe("instant");
  });
});

describe("shouldAct", () => {
  /**
   * The threshold rises with what it costs to be wrong, not with how hard the
   * judgement is.
   */
  it("demands more confidence for a costlier mistake", () => {
    expect(actThresholdFor("stage.advanced")).toBeGreaterThan(actThresholdFor("task.extracted"));
    expect(actThresholdFor("quote.sent")).toBeGreaterThan(actThresholdFor("stage.advanced"));
  });

  it("acts at or above the threshold", () => {
    expect(shouldAct("task.extracted", 0.6)).toBe(true);
    expect(shouldAct("task.extracted", 0.95)).toBe(true);
  });

  it("does nothing below it, rather than acting tentatively", () => {
    expect(shouldAct("stage.advanced", 0.84)).toBe(false);
    expect(shouldAct("quote.sent", 0.89)).toBe(false);
  });

  it.each([[null], [undefined], [Number.NaN], [-0.1], [1.1]])(
    "refuses to act on a confidence of %s",
    (confidence) => {
      expect(shouldAct("task.extracted", confidence as number | null)).toBe(false);
    },
  );
});

describe("buildDecision", () => {
  const base = {
    organizationId: "org-1",
    kind: "stage.advanced" as const,
    outcome: "applied" as const,
    triggerType: "inbound_event",
    triggerId: "receipt-1",
  };

  it("records everything a reviewer needs to judge the conclusion", () => {
    const row = buildDecision({
      ...base,
      dealId: "42",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "stage-inference@3",
      confidence: 0.91,
      inputs: { thread: "…" },
      decision: { toStage: "PROPOSAL" },
      summary: "  Customer confirmed budget  ",
    });

    expect(row).toMatchObject({
      kind: "stage.advanced",
      outcome: "applied",
      triggerType: "inbound_event",
      triggerId: "receipt-1",
      dealId: "42",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "stage-inference@3",
      confidence: 0.91,
      summary: "Customer confirmed budget",
    });
  });

  /**
   * A caller that could pass its own reversibility would eventually pass
   * `instant` for something that is not, and the review feed would promise a
   * manager an undo that does not exist.
   */
  it("derives reversibility rather than accepting it from the caller", () => {
    expect(buildDecision({ ...base, kind: "quote.sent" }).reversibility).toBe("hold");
    expect(buildDecision({ ...base, kind: "task.extracted" }).reversibility).toBe("instant");
  });

  it("normalises a blank summary to null rather than storing whitespace", () => {
    expect(buildDecision({ ...base, summary: "   " }).summary).toBeNull();
  });

  it("records a skipped decision as fully as an applied one", () => {
    const row = buildDecision({ ...base, outcome: "skipped", confidence: 0.4 });
    expect(row).toMatchObject({ outcome: "skipped", confidence: 0.4 });
  });
});

describe("redactForModel", () => {
  it("removes permission data before anything is sent", () => {
    const { context, removed } = redactForModel({
      subject: "Quote for Q3",
      actor: { name: "Priya", role: "CRM_ADMIN", permissions: ["crm:deals:update"] },
    });

    expect(context).toEqual({ subject: "Quote for Q3", actor: { name: "Priya" } });
    expect(removed).toEqual(expect.arrayContaining(["actor.role", "actor.permissions"]));
  });

  it.each([
    ["role"],
    ["roles"],
    ["permissions"],
    ["dataScope"],
    ["isOrgOwner"],
    ["grants"],
    ["memberships"],
    ["delegations"],
    ["rbac"],
  ])("strips %s wherever it appears", (key) => {
    const { context } = redactForModel({ nested: { deep: { [key]: "leaked" } } });
    expect(JSON.stringify(context)).not.toContain("leaked");
  });

  it("matches regardless of snake, kebab or camel casing", () => {
    const { context } = redactForModel({
      data_scope: "all",
      "is-org-owner": true,
      isOrgOwner: true,
    });
    expect(context).toEqual({});
  });

  it("strips credentials as well as permissions", () => {
    const { context } = redactForModel({ apiKey: "sk-live", passwordHash: "x", token: "y" });
    expect(context).toEqual({});
  });

  it("walks arrays, so a list of members is not a hole in the filter", () => {
    const { context } = redactForModel({
      members: [{ name: "Priya", role: "OWNER" }, { name: "Sam", role: "MEMBER" }],
    });
    expect(JSON.stringify(context)).not.toContain("OWNER");
    expect(JSON.stringify(context)).toContain("Priya");
  });

  it("leaves ordinary content untouched", () => {
    const context = { subject: "Quote", body: "Please send it", amount: 42, ok: true };
    expect(redactForModel(context).context).toEqual(context);
  });
});

describe("context limits", () => {
  it("caps text and says it did", () => {
    const capped = capText("x".repeat(100), 10);
    expect(capped).toContain("[truncated]");
    expect(capped.length).toBeLessThan(40);
  });

  it("leaves text within the cap exactly as it was", () => {
    expect(capText("  short  ", 100)).toBe("short");
  });

  it("caps rows", () => {
    expect(capRows([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });

  /** No provider call at all when there is nothing to work with. */
  it("reports no eligible context for empty or trivial input", () => {
    expect(hasEligibleContext([])).toBe(false);
    expect(hasEligibleContext([null, undefined, "   "])).toBe(false);
    expect(hasEligibleContext(["ok"])).toBe(false);
  });

  it("reports eligible context once there is something substantial", () => {
    expect(hasEligibleContext([null, "Can you send the quote for the Q3 renewal?"])).toBe(true);
  });
});
