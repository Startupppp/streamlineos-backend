import { verifyLeaveOpeningManifest } from "./backfill-manifest";
import { buildLeaveOpeningDryRunReport } from "./backfill-plan";
import {
  createBackfillTestFixture,
  fixtureNow,
} from "./backfill-test-fixture";

function report() {
  const fixture = createBackfillTestFixture();
  const verified = verifyLeaveOpeningManifest(
    fixture.rawManifest,
    fixture.manifestSha256,
    fixture.signature,
    fixture.publicKeyPem,
    fixture.keyId,
    fixtureNow,
  );
  return buildLeaveOpeningDryRunReport(verified);
}

describe("leave opening dry-run plan", () => {
  it("emits deterministic IDs, counts, months, hashes, and keys", () => {
    const first = report();
    expect(first.operationCount).toBe(5);
    expect(first.sourceRowCount).toBe(5);
    expect(first.requiredPartitionMonths).toEqual([
      "2025-01",
      "2025-02",
      "2026-01",
      "2026-02",
    ]);
    expect(first.operations[0]).toMatchObject({
      sourceBalanceId: 1,
      requiredPartitionMonth: "2025-01",
      sourceKey: "LEGACY_LEAVE_BALANCE:1:0",
    });
    expect(first.operations[0]?.commandKey).toMatch(
      /^HRMS_LEAVE_OPENING_BALANCE:[a-f0-9]{64}:1:0$/,
    );
    expect(first.operations[0]?.operationKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not emit individual balances, full dates, paths, names, or emails", () => {
    const output = JSON.stringify(report());
    expect(output).not.toContain('"sourceBalance":');
    expect(output).not.toContain('"effectiveDate":');
    expect(output).not.toContain("10.0000");
    expect(output).not.toContain("2025-01-15");
    expect(output).not.toContain("@example");
    expect(output).not.toContain("manifest.json");
    expect(output).not.toContain("BEGIN PUBLIC KEY");
  });
});
