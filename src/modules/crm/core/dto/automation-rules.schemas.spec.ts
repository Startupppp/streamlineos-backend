import {
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
} from "./automation-rules.schemas";

const VALID = {
  name: "Notify on new lead",
  trigger: "lead.created" as const,
  conditions: [{ field: "status", operator: "equals" as const, value: "NEW" }],
  actions: ["send_email" as const],
};

describe("createAutomationRuleSchema", () => {
  it("accepts the visual builder's author-owned fields", () => {
    const parsed = createAutomationRuleSchema.parse({
      ...VALID,
      graph: [{ id: "n1", type: "trigger", nextId: "n2" }],
      isDraft: true,
      cooldownMinutes: 15,
    });

    expect(parsed.graph).toEqual([{ id: "n1", type: "trigger", nextId: "n2" }]);
    expect(parsed.isDraft).toBe(true);
    expect(parsed.cooldownMinutes).toBe(15);
  });

  it("rejects server-owned fields instead of silently stripping them", () => {
    for (const field of ["executionCount", "lastRunAt", "version", "createdAt"]) {
      expect(() =>
        createAutomationRuleSchema.parse({ ...VALID, [field]: 0 }),
      ).toThrow();
    }
  });

  it("still accepts a payload with no graph, so non-builder callers keep working", () => {
    const parsed = createAutomationRuleSchema.parse(VALID);

    expect(parsed.graph).toBeUndefined();
    expect(parsed.isActive).toBe(true);
  });

  it("caps graph size so a payload cannot be used to bloat the row", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      id: `n${i}`,
      type: "action",
    }));

    expect(() =>
      createAutomationRuleSchema.parse({ ...VALID, graph: tooMany }),
    ).toThrow();
  });

  it("rejects a negative cooldown", () => {
    expect(() =>
      createAutomationRuleSchema.parse({ ...VALID, cooldownMinutes: -1 }),
    ).toThrow();
  });
});

describe("updateAutomationRuleSchema", () => {
  it("accepts a graph-only patch", () => {
    const parsed = updateAutomationRuleSchema.parse({ graph: null });

    expect(parsed.graph).toBeNull();
  });

  it("rejects server-owned fields on update, which previously reset the counter", () => {
    expect(() =>
      updateAutomationRuleSchema.parse({ executionCount: 0 }),
    ).toThrow();
  });
});
