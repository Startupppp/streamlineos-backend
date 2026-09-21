import { readFileSync } from "node:fs";
import { join } from "node:path";
import { onboardEmployeeSchema } from "./hr-directory.schemas";

const BASE = {
  firstName: "Ada",
  lastName: "Lovelace",
  designation: "Engineer",
  reportingManagerUserId: "user-manager",
};

function parse(email: string) {
  return onboardEmployeeSchema.parse({ ...BASE, email });
}

describe("onboardEmployeeSchema — email canonicalization", () => {
  it.each([
    ["  User@Example.COM  ", "user@example.com"],
    ["USER@EXAMPLE.COM", "user@example.com"],
    ["\tuser@Example.com\n", "user@example.com"],
  ])("canonicalizes %j to %j at the boundary", (input, expected) => {
    expect(parse(input).email).toBe(expected);
  });

  it("rejects a value that is not an email, so the raw z.string() cannot come back", () => {
    for (const bad of ["", "   ", "not-an-email", "a@b"]) {
      expect(() => parse(bad)).toThrow();
    }
  });

  it("leaves the onboarding service nothing to re-normalize", () => {
    const source = readFileSync(
      join(__dirname, "..", "employee-onboarding.service.ts"),
      "utf8",
    );

    expect(source).not.toContain("body.email.toLowerCase()");
    expect(source).not.toContain("body.email.trim()");
  });
});
