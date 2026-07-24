import expected from "./fixtures/replay-expected.json";
import { calcPayroll } from "../calculation-engine";
import { REPLAY_FIXTURE_INPUT } from "./fixtures/replay-fixture";

function stableSnapshot() {
  const { computedAt: _computedAt, ...rest } = calcPayroll(REPLAY_FIXTURE_INPUT);
  return rest;
}

describe("payroll snapshot replay", () => {
  it("replays the frozen fixture to a byte-identical snapshot (excluding computedAt)", () => {
    expect(stableSnapshot()).toEqual(expected);
  });

  it("is deterministic across repeated runs on identical inputs", () => {
    expect(stableSnapshot()).toEqual(stableSnapshot());
  });

  it("guards the frozen baseline shape so drift cannot hide behind an empty fixture", () => {
    expect(expected.lines.length).toBeGreaterThanOrEqual(10);
    const codes = expected.lines.map((line) => line.code);
    for (const code of ["BASIC", "HRA", "EPF_EMPLOYEE", "PROFESSIONAL_TAX", "TDS", "LOAN_EMI_9"]) {
      expect(codes).toContain(code);
    }
    expect(Number.parseFloat(expected.totals.net)).toBeGreaterThan(0);
  });
});
