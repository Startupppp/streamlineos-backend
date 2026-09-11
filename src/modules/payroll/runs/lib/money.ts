export interface RoundingConfig {
  mode: "NEAREST" | "UP" | "DOWN";
  precision: 0 | 2;
}

export function toPaise(s: string): number {
  return Math.round(parseFloat(s) * 100);
}

export function fromPaise(n: number): string {
  return (n / 100).toFixed(2);
}

export function applyRounding(paise: number, cfg: RoundingConfig): number {
  const rupees = paise / 100;
  if (cfg.precision === 0) {
    if (cfg.mode === "NEAREST") return Math.round(rupees) * 100;
    if (cfg.mode === "UP") return Math.ceil(rupees) * 100;
    return Math.floor(rupees) * 100;
  }
  if (cfg.mode === "NEAREST") return Math.round(paise);
  if (cfg.mode === "UP") return Math.ceil(paise);
  return Math.floor(paise);
}

export function pctOf(basePaise: number, percentStr: string): number {
  return Math.round(basePaise * parseFloat(percentStr) / 100);
}

export function daysInMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(year, mon, 0).getDate();
}
