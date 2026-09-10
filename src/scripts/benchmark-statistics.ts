/** CPU clock resolution and interpolated percentiles used by the access benchmark. */
export function measureCpuClockGranularityUs(): number {
  const deltas: number[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const before = process.cpuUsage();
    let delta = 0;
    while (delta === 0) {
      const after = process.cpuUsage(before);
      delta = after.user + after.system;
    }
    deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? 0;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function benchmarkOutcome(
  cpuP99: number | null,
  wallP99: number | null,
  target: number,
): { verdict: "MET" | "BREACHED"; exitCode: 0 | 1 } {
  const met =
    Number.isFinite(target) && target > 0 &&
    cpuP99 !== null && Number.isFinite(cpuP99) && cpuP99 >= 0 && cpuP99 <= target &&
    wallP99 !== null && Number.isFinite(wallP99) && wallP99 >= 0 && wallP99 <= target;
  return { verdict: met ? "MET" : "BREACHED", exitCode: met ? 0 : 1 };
}
