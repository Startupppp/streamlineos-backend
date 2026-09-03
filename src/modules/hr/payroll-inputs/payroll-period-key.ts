export function periodBoundsFrom(periodKey: string): { start: string; end: string } {
  const [year, month] = periodKey.split("-");
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return {
    start: `${periodKey}-01`,
    end: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function nextMonthKey(periodKey: string): string {
  const [year, month] = periodKey.split("-").map(Number);
  const next = new Date(year, month ?? 1, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}
