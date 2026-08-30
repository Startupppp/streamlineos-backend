export function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  if (p <= 0) return sortedMs[0];
  if (p >= 100) return sortedMs[sortedMs.length - 1];
  const rank = (p / 100) * (sortedMs.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedMs[low];
  return sortedMs[low] + (sortedMs[high] - sortedMs[low]) * (rank - low);
}

export function summarise(samplesMs) {
  const ok = samplesMs.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (ok.length === 0)
    return { count: 0, p50: null, p75: null, p95: null, p99: null, max: null, mean: null };
  const sum = ok.reduce((a, b) => a + b, 0);
  return {
    count: ok.length,
    p50: percentile(ok, 50),
    p75: percentile(ok, 75),
    p95: percentile(ok, 95),
    p99: percentile(ok, 99),
    max: ok[ok.length - 1],
    mean: sum / ok.length,
  };
}

export function achievedRate(count, durationMs) {
  if (durationMs <= 0) return 0;
  return (count / durationMs) * 1000;
}

export const VERDICTS = ["MET", "BREACHED", "NOT_DRIVEN"];

export function judge(objective, summary) {
  if (summary === null || summary.count === 0)
    return { verdict: "NOT_DRIVEN", measured: null };
  const measured = summary[objective.percentileKey];
  if (measured === null || measured === undefined)
    return { verdict: "NOT_DRIVEN", measured: null };
  return {
    verdict: measured <= objective.target ? "MET" : "BREACHED",
    measured,
  };
}
