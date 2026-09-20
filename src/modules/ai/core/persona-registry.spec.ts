import { getPersona, isValidPersona, listPersonas, PERSONA_IDS } from "./persona-registry";
import { chatRequestSchema } from "./dto/request.schemas";

describe("a persona is a focus hint, never a capability gate", () => {
  it("still offers the five personas the chip strip renders", () => {
    expect(listPersonas()).toHaveLength(5);
    expect(PERSONA_IDS).toEqual(["support", "sales", "hr-policy", "project", "operations"]);
  });

  it("no longer carries an allowlist, so a persona cannot remove a tool the caller may use", () => {
    for (const persona of listPersonas()) {
      expect(persona).not.toHaveProperty("allowedTools");
    }
  });

  it("phrases every preamble as a lead, not a prohibition, so the assistant still answers off-topic questions", () => {
    for (const persona of listPersonas()) {
      expect(persona.preamble).toContain("but answer anything they ask");
      expect(persona.preamble).not.toContain("Do not discuss");
    }
  });

  it("resolves a known persona and rejects an unknown one", () => {
    expect(getPersona("sales")?.label).toBe("CRM");
    expect(getPersona("nope")).toBeUndefined();
    expect(isValidPersona("hr-policy")).toBe(true);
    expect(isValidPersona("hr_policy")).toBe(false);
  });
});

describe("an unrecognised persona is refused at the boundary rather than failing open", () => {
  const body = { messages: [{ role: "user" as const, content: "hi" }] };

  it("accepts a known persona", () => {
    expect(chatRequestSchema.safeParse({ ...body, persona: "sales" }).success).toBe(true);
  });

  it("accepts an omitted persona", () => {
    expect(chatRequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects a typo instead of granting the full tool surface", () => {
    expect(chatRequestSchema.safeParse({ ...body, persona: "sales " }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...body, persona: "admin" }).success).toBe(false);
  });
});
