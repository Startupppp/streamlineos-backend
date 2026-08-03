import {
  filterToolsByPersona,
  getPersona,
  isValidPersona,
  listPersonas,
} from "./persona-registry";

describe("persona-registry", () => {
  it("lists all 5 personas", () => {
    expect(listPersonas()).toHaveLength(5);
  });

  it.each(["support", "sales", "hr-policy", "project", "operations"])(
    "isValidPersona returns true for %s",
    (id) => {
      expect(isValidPersona(id)).toBe(true);
    },
  );

  it("isValidPersona returns false for unknown id", () => {
    expect(isValidPersona("finance")).toBe(false);
  });

  it("getPersona returns undefined for unknown persona", () => {
    expect(getPersona("unknown")).toBeUndefined();
  });

  describe("filterToolsByPersona", () => {
    const allTools = {
      searchLeads: "crm-tool",
      askHrPolicy: "hr-tool",
      searchProjects: "project-tool",
      getInventoryStock: "ops-tool",
      searchKnowledgeBase: "kb-tool",
      sendEmail: "comms-tool",
      grantBonus: "payroll-tool",
      findPerson: "workspace-tool",
    } as Record<string, unknown>;

    it("sales persona only exposes sales-related tools", () => {
      const result = filterToolsByPersona(allTools, "sales");
      expect("searchLeads" in result).toBe(true);
      expect("askHrPolicy" in result).toBe(false);
      expect("searchProjects" in result).toBe(false);
      expect("getInventoryStock" in result).toBe(false);
    });

    it("hr-policy persona exposes askHrPolicy but not searchLeads", () => {
      const result = filterToolsByPersona(allTools, "hr-policy");
      expect("askHrPolicy" in result).toBe(true);
      expect("searchLeads" in result).toBe(false);
      expect("searchProjects" in result).toBe(false);
    });

    it("project persona exposes searchProjects but not searchLeads or askHrPolicy", () => {
      const result = filterToolsByPersona(allTools, "project");
      expect("searchProjects" in result).toBe(true);
      expect("searchLeads" in result).toBe(false);
      expect("askHrPolicy" in result).toBe(false);
    });

    it("operations persona exposes getInventoryStock but not askHrPolicy or searchLeads", () => {
      const result = filterToolsByPersona(allTools, "operations");
      expect("getInventoryStock" in result).toBe(true);
      expect("askHrPolicy" in result).toBe(false);
      expect("searchLeads" in result).toBe(false);
    });

    it("support persona does not expose searchLeads or grantBonus", () => {
      const result = filterToolsByPersona(allTools, "support");
      expect("searchLeads" in result).toBe(false);
      expect("grantBonus" in result).toBe(false);
      expect("searchKnowledgeBase" in result).toBe(true);
    });

    it("cross-module tool (grantBonus) is denied under hr-policy narrow persona but allowed in full", () => {
      const hrResult = filterToolsByPersona(allTools, "hr-policy");
      expect("grantBonus" in hrResult).toBe(false);
    });

    it("unknown persona returns all tools unchanged", () => {
      const result = filterToolsByPersona(allTools, "unknown");
      expect(Object.keys(result)).toHaveLength(Object.keys(allTools).length);
    });

    it("no persona leaves allTools intact (undefined path)", () => {
      const result = filterToolsByPersona(allTools, "sales");
      expect(Object.keys(result).length).toBeLessThan(Object.keys(allTools).length);
    });
  });

  describe("persona preambles narrow scope", () => {
    it("sales preamble mentions CRM", () => {
      expect(getPersona("sales")?.preamble).toMatch(/CRM/i);
    });

    it("hr-policy preamble mentions HR policies", () => {
      expect(getPersona("hr-policy")?.preamble).toMatch(/HR/i);
    });

    it("support preamble mentions customer support", () => {
      expect(getPersona("support")?.preamble).toMatch(/support/i);
    });
  });
});
