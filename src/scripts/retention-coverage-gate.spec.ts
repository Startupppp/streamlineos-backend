import { runGate, GateRun } from "./retention-coverage-gate-helpers";

function envWithoutDatabaseUrl(): NodeJS.ProcessEnv {
  const stripped = { ...process.env };
  delete stripped.DATABASE_URL;
  return stripped;
}

describe("check:retention-coverage — source-verifiable invariants", () => {
  describe("defect 1 — integer division made every sub-megabyte table measure zero", () => {
    it("the shipped query divides by a numeric literal, and is the one the gate runs", () => {
      const run: GateRun = runGate(["--print-query"], envWithoutDatabaseUrl());
      expect(run.status).toBe(0);
      const printed = JSON.parse(run.stdout) as {
        totalMbExpression: string;
        catalogueQuery: string;
      };
      expect(printed.totalMbExpression).toMatch(/\/\s*1048576\.\d/);
      expect(printed.totalMbExpression).not.toMatch(/\/\s*1048576\s*(?![.\d])/);
      expect(printed.catalogueQuery).toContain(printed.totalMbExpression);
    });
  });

  describe("defect 2 — a corpus that classified nothing must not report clean", () => {
    it("an absent DATABASE_URL is INCONCLUSIVE, not a silent fallback to .env", () => {
      const run: GateRun = runGate([], envWithoutDatabaseUrl());
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("INCONCLUSIVE");
      expect(run.stdout).toBe("");
    });
  });
});
