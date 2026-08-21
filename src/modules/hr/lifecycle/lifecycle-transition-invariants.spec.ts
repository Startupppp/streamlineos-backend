import { readFileSync } from "node:fs";
import { join } from "node:path";

function readLifecycleSource(fileName: string): string {
  return readFileSync(join(__dirname, fileName), "utf8");
}

describe("HR lifecycle transition invariants", () => {
  const transitionSource = readLifecycleSource("lifecycle-transition.ts");

  it("matches organization, identity, status and version before incrementing", () => {
    for (const predicate of [
      "eq(resignations.orgId, input.organizationId)",
      "eq(resignations.id, input.resignationId)",
      "eq(resignations.status, input.currentStatus)",
      "eq(resignations.rowVersion, input.currentVersion)",
      "eq(terminations.orgId, input.organizationId)",
      "eq(terminations.id, input.terminationId)",
      "eq(terminations.status, input.currentStatus)",
      "eq(terminations.rowVersion, input.currentVersion)",
    ]) {
      expect(transitionSource).toContain(predicate);
    }
    expect(transitionSource.match(/rowVersion: sql<number>/g)).toHaveLength(2);
    expect(transitionSource.match(/throw new ConflictException/g)).toHaveLength(2);
  });

  it("routes audited resignation and termination writers through the CAS helper", () => {
    for (const fileName of [
      "exit-write.service.ts",
      "exit.service.ts",
      "termination.service.ts",
    ]) {
      const source = readLifecycleSource(fileName);
      expect(source).not.toMatch(/\.update\((?:resignations|terminations)\)/);
    }
  });

  it("allocates onboarding document versions under a transaction lock in SQL", () => {
    const source = readLifecycleSource("onboarding-views.service.ts");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("COALESCE(MAX(existing_document.version), 0) + 1");
    expect(source).not.toContain("const nextVersion");
  });
});
