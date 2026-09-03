import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A payroll collection read must never come back short without saying so.
 *
 * There are two bounded shapes in this tree and both are accepted here:
 *
 *  - a **literal ceiling** (`.limit(100)` / `.limit(1000)`), which is honest
 *    only where the set genuinely cannot exceed it; and
 *  - the **probe** idiom — `.limit(<CAP> + 1)` read one row past the bound and
 *    handed to an overflow guard (`requirePayrollReadWithinCap`,
 *    `assertNotTruncated`) that turns the extra row into a visible failure.
 *
 * The probe is the stronger of the two, but only while the guard is actually
 * there: a bare `.limit(CAP + 1)` truncates at CAP + 1 instead of CAP and is
 * no better than the literal it replaced. So every probe in the file must be
 * matched by a guard call — the floor that stops this check passing
 * vacuously once a read migrates from a literal ceiling to a probe.
 */
describe("S02 Payroll collection read caps", () => {
  const sourceRoot = resolve(__dirname, "../..");
  const cappedQueries: Array<[string, string]> = [
    ["hr/payroll-inputs/payroll-input-snapshots.service.ts", ".select({"],
    ["hr/payroll-inputs/payroll-inputs-build.service.ts", ".select({"],
    ["payroll/insights/journal.service.ts", ".select({"],
    ["payroll/insights/journal-outbox.service.ts", ".select(journalBatchLineSelection)"],
    ["payroll/runs/loan-recovery.service.ts", ".select({ calculationSnapshot:"],
    ["payroll/runs/payroll-run-variance.service.ts", ".select({ userId:"],
    ["payroll/runs/run-data-loader.service.ts", "id: employeeSalaryProfiles.id"],
    ["payroll/runs/salary-profiles.repository.ts", "id: employeeSalaryProfileComponents.id"],
  ];

  const LITERAL_CAP = /\.limit\((100|1000)\)/;
  const PROBE_CAP = /\.limit\([A-Z][A-Z0-9_]* \+ 1\)/g;
  const OVERFLOW_GUARD = /\b(?:requirePayrollReadWithinCap|assertNotTruncated)\(/g;

  it.each(cappedQueries)("keeps %s bounded near %s", (relativePath, anchor) => {
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);

    // The window is the anchored read itself: everything up to the next
    // `.select(`. A fixed character count either cuts a long query short or
    // lets it borrow the *following* read's `.limit(` and pass while unbounded.
    const nextSelect = source.indexOf(".select(", start + anchor.length);
    const window = source.slice(start, nextSelect === -1 ? source.length : nextSelect);
    const probes = source.match(PROBE_CAP) ?? [];

    expect(window).toMatch(/\.limit\(/);

    if (probes.length > 0) {
      // The file bounds reads with the probe idiom; every probe in it must be
      // matched by a guard call, or the extra row is silently kept and the
      // probe is no better than the literal ceiling it replaced.
      const guards = source.match(OVERFLOW_GUARD) ?? [];
      expect(guards.length).toBeGreaterThanOrEqual(probes.length);
    } else {
      expect(window).toMatch(LITERAL_CAP);
    }
  });
});
