import { PERMISSIONS } from "../permissions";

const SENSITIVE_KEYS = PERMISSIONS.filter((p) => p.sensitive === true).map((p) => p.name);

describe("permission sensitivity is structured catalogue metadata", () => {
  it("flags every key whose description announces it as sensitive so the marker and the field cannot drift apart", () => {
    const announced = PERMISSIONS.filter((p) => p.description.includes("(sensitive)")).map((p) => p.name);
    expect(announced.length).toBeGreaterThan(0);
    for (const key of announced) expect(SENSITIVE_KEYS).toContain(key);
  });

  it("flags the hr:sensitive resource keys because they expose salary, bank, tax, government id and medical fields", () => {
    expect(SENSITIVE_KEYS).toEqual(expect.arrayContaining(["hr:sensitive:view", "hr:sensitive:manage"]));
  });

  it("leaves ordinary keys unflagged so sensitivity stays a narrow signal rather than a default", () => {
    const ordinary = PERMISSIONS.find((p) => p.name === "build:tickets:view");
    expect(ordinary).toBeDefined();
    expect(ordinary?.sensitive).toBeUndefined();
    expect(SENSITIVE_KEYS.length).toBeLessThan(PERMISSIONS.length / 10);
  });
});
