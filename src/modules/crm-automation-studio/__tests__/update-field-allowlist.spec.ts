const ALLOWLISTED_LEAD_FIELDS = ["status", "priority", "source", "assignedToId", "score"];
const ALLOWLISTED_DEAL_FIELDS = ["stage", "priority", "assignedToId"];

function simulateUpdateField(entityType: string, field: string): { status: string; message?: string } {
  const allowlist = entityType === "lead" ? ALLOWLISTED_LEAD_FIELDS : entityType === "deal" ? ALLOWLISTED_DEAL_FIELDS : null;
  if (!allowlist) return { status: "skipped", message: "unsupported_entity" };
  if (!allowlist.includes(field)) return { status: "error", message: "field_not_allowed" };
  return { status: "ok" };
}

describe("update_field allowlist enforcement", () => {
  it("lead: allowlisted field 'status' → ok", () => {
    expect(simulateUpdateField("lead", "status").status).toBe("ok");
  });

  it("lead: allowlisted field 'score' → ok", () => {
    expect(simulateUpdateField("lead", "score").status).toBe("ok");
  });

  it("lead: protected field 'orgId' → error field_not_allowed", () => {
    const result = simulateUpdateField("lead", "orgId");
    expect(result.status).toBe("error");
    expect(result.message).toBe("field_not_allowed");
  });

  it("lead: protected field 'id' → error field_not_allowed", () => {
    const result = simulateUpdateField("lead", "id");
    expect(result.status).toBe("error");
    expect(result.message).toBe("field_not_allowed");
  });

  it("deal: allowlisted field 'stage' → ok", () => {
    expect(simulateUpdateField("deal", "stage").status).toBe("ok");
  });

  it("deal: protected field 'name' → error field_not_allowed", () => {
    const result = simulateUpdateField("deal", "name");
    expect(result.status).toBe("error");
    expect(result.message).toBe("field_not_allowed");
  });

  it("unknown entity type → skipped", () => {
    expect(simulateUpdateField("contact", "status").status).toBe("skipped");
  });
});
