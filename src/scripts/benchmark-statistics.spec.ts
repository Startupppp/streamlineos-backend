import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { benchmarkOutcome, measureCpuClockGranularityUs, percentile } from "./benchmark-statistics";

describe("access benchmark statistics", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not report a percentile without samples", () => {
    expect(percentile([], 99)).toBeNull();
  });

  it("a wall-only breach produces a nonzero process exit without running the benchmark", () => {
    const child = spawnSync(process.execPath, [
      "-r", require.resolve("ts-node/register/transpile-only"), "-e",
      "const { benchmarkOutcome } = require('./src/scripts/benchmark-statistics'); " +
      "const outcome = benchmarkOutcome(50, 200, 100); " +
      "console.log(outcome.verdict); process.exitCode = outcome.exitCode;",
    ], { cwd: resolve(__dirname, "../.."), encoding: "utf8", timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe("BREACHED");
    expect(child.status).toBe(1);
  });

  it.each([
    [0, 0, 100], [50, 80, 100], [100, 100, 100],
  ])("passes only when both measured percentiles meet target (%s, %s, %s)", (cpu, wall, target) => {
    expect(benchmarkOutcome(cpu, wall, target)).toEqual({ verdict: "MET", exitCode: 0 });
  });

  it.each<[number | null, number | null, number]>([
    [101, 50, 100], [50, 101, 100], [101, 101, 100],
    [null, 50, 100], [50, null, 100], [null, null, 100],
    [NaN, 50, 100], [50, NaN, 100],
    [Infinity, 50, 100], [50, Infinity, 100],
    [-Infinity, 50, 100], [50, -Infinity, 100],
    [-1, 50, 100], [50, -1, 100],
    [50, 50, Infinity], [50, 50, NaN], [0, 0, 0],
  ])("fails closed for breached, missing or invalid measurements (%s, %s, %s)", (cpu, wall, target) => {
    expect(benchmarkOutcome(cpu, wall, target)).toEqual({ verdict: "BREACHED", exitCode: 1 });
  });

  it.each([
    [-10, 10], [0, 10], [50, 20], [75, 30], [99, 39.6], [100, 40], [110, 40],
  ])("interpolates and clamps percentile %s", (p, expected) => {
    expect(percentile([10, 20, 40], p)).toBeCloseTo(expected);
  });

  it("keeps a single sample's value at every percentile", () => {
    expect(percentile([7], 99)).toBe(7);
  });

  it("measures nonzero combined CPU ticks and takes their ordered middle sample", () => {
    const usage = jest.spyOn(process, "cpuUsage");
    for (let tick = 20; tick >= 1; tick--) {
      usage.mockReturnValueOnce({ user: 100, system: 20 });
      usage.mockReturnValueOnce({ user: 0, system: 0 });
      usage.mockReturnValueOnce({ user: tick, system: tick });
    }

    expect(measureCpuClockGranularityUs()).toBe(22);
    expect(usage).toHaveBeenCalledTimes(60);
    expect(usage).toHaveBeenNthCalledWith(2, { user: 100, system: 20 });
    expect(usage).toHaveBeenNthCalledWith(3, { user: 100, system: 20 });
  });
});
