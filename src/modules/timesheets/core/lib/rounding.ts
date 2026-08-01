
const INCREMENT_MINUTES: Record<string, number> = {
  NEAREST_5: 5,
  NEAREST_6: 6,
  NEAREST_10: 10,
  NEAREST_15: 15,
  ROUND_UP: 15,
  ROUND_DOWN: 15,
};

function to2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundHours(hours: number, rule: string | null | undefined): number {
  if (hours <= 0) return 0;
  if (!rule || rule === "NONE") return to2(hours);
  const increment = INCREMENT_MINUTES[rule];
  if (!increment) return to2(hours);
  const units = (hours * 60) / increment;
  const roundedUnits =
    rule === "ROUND_UP"
      ? Math.ceil(units)
      : rule === "ROUND_DOWN"
        ? Math.floor(units)
        : Math.round(units);
  return to2((roundedUnits * increment) / 60);
}
