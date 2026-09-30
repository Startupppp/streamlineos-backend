import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(__dirname, "invitation-acceptance.service.ts"),
  "utf8",
);

function bodyOf(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.indexOf("\n  private async ", start + 1);
  const alt = source.indexOf("\n  async ", start + 1);
  const candidates = [next, alt].filter((i) => i > 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

describe("invitation acceptance email-ownership gate", () => {
  it("verifies the emailed code before either acceptance branch mints a session", () => {
    const accept = bodyOf("accept");
    const gate = accept.indexOf("verifyAndConsumeInvitationOtp");
    const existingBranch = accept.indexOf("acceptAsExistingUser");
    const newBranch = accept.indexOf("acceptAsNewUser");

    expect(gate).toBeGreaterThan(-1);
    expect(existingBranch).toBeGreaterThan(gate);
    expect(newBranch).toBeGreaterThan(gate);
  });

  it("consumes the code exactly once so the second branch cannot reject a code the first already spent", () => {
    const occurrences = source.split("await this.verifyAndConsumeInvitationOtp")
      .length - 1;

    expect(occurrences).toBe(1);
  });

  it("refuses an acceptance carrying no code at all", () => {
    const accept = bodyOf("accept");

    expect(accept).toContain("if (!input.emailOtp)");
    expect(accept.indexOf("if (!input.emailOtp)")).toBeLessThan(
      accept.indexOf("acceptAsExistingUser"),
    );
  });

  it("still issues the auto-login magic link once the code has been proven", () => {
    expect(bodyOf("acceptAsExistingUser")).toContain("issueMagicLink");
    expect(bodyOf("acceptAsNewUser")).toContain("issueMagicLink");
  });
});
