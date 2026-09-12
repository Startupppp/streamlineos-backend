import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LABOR_STANDARD,
  binChangesBetween,
  performanceOf,
  standardSecondsFor,
} from "../labor-standard";

describe("NEO-7 - the standard", () => {
  it("charges setup once, per scan, per bin change and per extra unit", () => {
    const seconds = standardSecondsFor({ scanCount: 2, distanceProxy: 1, unitsDone: "3.0000" });
    expect(seconds).toBe(
      LABOR_STANDARD.setupSeconds +
        2 * LABOR_STANDARD.perScanSeconds +
        1 * LABOR_STANDARD.perBinChangeSeconds +
        2 * LABOR_STANDARD.perUnitSeconds,
    );
  });

  it("charges nothing extra for the first unit", () => {
    // Picking twelve is not twelve times picking one, and a standard that says
    // otherwise punishes exactly the case-pick a warehouse wants encouraged.
    const one = standardSecondsFor({ scanCount: 1, distanceProxy: 1, unitsDone: "1.0000" });
    const two = standardSecondsFor({ scanCount: 1, distanceProxy: 1, unitsDone: "2.0000" });
    expect(two - one).toBe(LABOR_STANDARD.perUnitSeconds);
  });

  it("never returns zero", () => {
    // A standard of zero makes performance a division by zero, and every board
    // that reads it shows infinity beside a real person's name.
    expect(standardSecondsFor({ scanCount: 0, distanceProxy: 0, unitsDone: "0" })).toBeGreaterThan(0);
    expect(standardSecondsFor({ scanCount: -5, distanceProxy: -5, unitsDone: "-5" })).toBeGreaterThan(0);
  });
});

describe("NEO-7 - performance", () => {
  it("reads above 100 as faster than standard", () => {
    // The direction every warehouse already means by "performance". Inverting it
    // would make every conversation about this board start with an explanation.
    const fast = performanceOf({
      userId: "u1", lines: 10, unitsDone: 100, actualSeconds: 500, standardSeconds: 1000,
    });
    expect(fast.performancePct).toBe(200);

    const slow = performanceOf({
      userId: "u2", lines: 10, unitsDone: 100, actualSeconds: 2000, standardSeconds: 1000,
    });
    expect(slow.performancePct).toBe(50);
  });

  it("reports units per hour, and null rather than a division by zero", () => {
    const measured = performanceOf({
      userId: "u1", lines: 4, unitsDone: 120, actualSeconds: 3600, standardSeconds: 3600,
    });
    expect(measured.unitsPerHour).toBe(120);

    const nothing = performanceOf({
      userId: "u2", lines: 0, unitsDone: 0, actualSeconds: 0, standardSeconds: 0,
    });
    expect(nothing.unitsPerHour).toBeNull();
    expect(nothing.performancePct).toBe(0);
  });

  it("tells two pickers apart", () => {
    // The work order's own acceptance: two pickers' rates visible.
    const board = [
      { userId: "fast", lines: 20, unitsDone: 200, actualSeconds: 1800, standardSeconds: 2400 },
      { userId: "steady", lines: 20, unitsDone: 200, actualSeconds: 2400, standardSeconds: 2400 },
    ].map(performanceOf);

    expect(board[0]!.performancePct).toBeGreaterThan(board[1]!.performancePct);
    expect(board[0]!.unitsPerHour).toBeGreaterThan(board[1]!.unitsPerHour!);
  });
});

describe("NEO-7 - the distance proxy", () => {
  it("counts a bin change as one move and a repeat visit as none", () => {
    expect(binChangesBetween(null, 5)).toBe(1);
    expect(binChangesBetween(5, 5)).toBe(0);
    expect(binChangesBetween(5, 6)).toBe(1);
  });

  it("charges nothing when there is no bin at all", () => {
    expect(binChangesBetween(5, null)).toBe(0);
  });
});

/**
 * The ratchet the module's own prose promises: labour measurement must not
 * become payroll inside inventory.
 *
 * Names, not shapes: a check for "does not compute money" would be unfalsifiable.
 * Naming the payroll tables and the pay-bearing words means a genuinely new
 * reference has to be added here, which is the moment somebody reads what it
 * does — the same argument `inventory-scope-cache-keys.spec.ts` makes for its
 * allowlist.
 */
const PAYROLL_SHAPES = [
  /payroll/i,
  /\bwages?\b/i,
  /\bsalar(y|ies)\b/i,
  /piece[_ -]?rate/i,
  /hr_employments/,
  /\bworkers\b/,
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("NEO-7 - labour is not payroll", () => {
  it("finds the module at all, so a broken walk cannot pass silently", () => {
    expect(sourceFiles(join(__dirname, "..")).length).toBeGreaterThanOrEqual(4);
  });

  it("names no payroll table and no pay-bearing concept", () => {
    const offenders: Array<[string, string]> = [];
    for (const path of sourceFiles(join(__dirname, ".."))) {
      const source = readFileSync(path, "utf8")
        // The prose says "not payroll" on purpose; the ratchet is about code.
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
      for (const shape of PAYROLL_SHAPES) {
        if (shape.test(source)) offenders.push([path, String(shape)]);
      }
    }
    expect(offenders).toEqual([]);
  });
});
