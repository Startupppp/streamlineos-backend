import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), "utf8");
}

function assertBoundedNearEvery(sourceText: string, anchor: string, window = 420): void {
  let offset = 0;
  let found = false;
  while (true) {
    const start = sourceText.indexOf(anchor, offset);
    if (start === -1) break;
    found = true;
    expect(sourceText.slice(start, start + window)).toMatch(/\.limit\(/);
    offset = start + anchor.length;
  }
  expect(found).toBe(true);
}

describe("HR lifecycle collection reads", () => {
  it("caps department lookup collections used by analytics", () => {
    const analyticsSource = source("lifecycle/hr-analytics.service.ts");
    expect((analyticsSource.match(/\.limit\(1_000\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("caps dashboard export materialization", () => {
    expect(source("lifecycle/hr-dashboard-reports.service.ts")).toMatch(
      /exportRows\(orgId: string\)[\s\S]{0,1500}\.where\(eq\(organizationMembers\.orgId, orgId\)\)\s*\.limit\(10_000\)/,
    );
  });

  it("caps probation person resolution to the requested id set", () => {
    assertBoundedNearEvery(source("lifecycle/probation-review-reader.service.ts"), "select({ id: hrPeople.id", 500);
  });

  it("caps onboarding template selection", () => {
    assertBoundedNearEvery(source("onboarding/core/onboarding-initiation.service.ts"), "select({ id: onboardingTemplates.id", 700);
  });

  it("keeps both payroll snapshot reads bounded", () => {
    const snapshotSource = source("payroll-inputs/payroll-input-snapshots.service.ts");
    expect(snapshotSource).toMatch(/\.select\(\{[\s\S]{0,500}\.limit\(1000\)/);
    expect(snapshotSource).toMatch(/\.select\(\{[\s\S]{0,1400}\.limit\(input\.limit \+ 1\)/);
  });
});
