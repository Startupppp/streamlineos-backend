import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("cycle progress completion semantics", () => {
  it("uses project status type instead of the DONE name", () => {
    const source = readFileSync(join(__dirname, "cycles.service.ts"), "utf8");

    expect(source).toContain("projectStatuses");
    expect(source).toContain("cycle_status.type = 'completed'");
    expect(source).not.toContain("tickets.status} = 'DONE'");
  });
});
