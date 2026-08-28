export const ADMISSION_THRESHOLD = 0.6;

export interface CellUtilisation {
  readonly cellId: string;
  readonly limitingResource: string;
  readonly used: number;
  readonly limit: number;
  readonly measuredAt: number;
}

export type SaturationForecast =
  | { readonly forecastable: true; readonly projectedAt: number; readonly projectedRatio: number }
  | { readonly forecastable: false; readonly reason: string };

export function utilisationRatio(u: CellUtilisation): number {
  return u.used / u.limit;
}

export function admits(u: CellUtilisation): boolean {
  return utilisationRatio(u) < ADMISSION_THRESHOLD;
}

export function headroomOrganizations(u: CellUtilisation, perOrgCost: number): number {
  if (perOrgCost <= 0) return 0;
  const headroom = u.limit * ADMISSION_THRESHOLD - u.used;
  return Math.max(0, Math.floor(headroom / perOrgCost));
}

export function saturationForecast(
  history: readonly CellUtilisation[],
  perOrgCost: number,
): SaturationForecast {
  if (history.length < 2)
    return { forecastable: false, reason: "insufficient samples" };

  const sorted = [...history].sort((a, b) => a.measuredAt - b.measuredAt);
  const n = sorted.length;

  const points = sorted.map((u) => ({ t: u.measuredAt, r: utilisationRatio(u) }));

  const sumT = points.reduce((acc, p) => acc + p.t, 0);
  const sumR = points.reduce((acc, p) => acc + p.r, 0);
  const sumTR = points.reduce((acc, p) => acc + p.t * p.r, 0);
  const sumT2 = points.reduce((acc, p) => acc + p.t * p.t, 0);
  const meanT = sumT / n;
  const meanR = sumR / n;
  const denominator = sumT2 - n * meanT * meanT;

  if (denominator === 0)
    return { forecastable: false, reason: "flat or negative trend" };

  const slope = (sumTR - n * meanT * meanR) / denominator;

  if (slope <= 0)
    return { forecastable: false, reason: "flat or negative trend" };

  const last = sorted.at(-1);
  if (last === undefined)
    return { forecastable: false, reason: "insufficient samples" };

  const adjustedCurrentRatio = utilisationRatio(last) + (last.limit > 0 ? perOrgCost / last.limit : 0);
  const timeToSaturation = (1.0 - adjustedCurrentRatio) / slope;

  if (timeToSaturation <= 0)
    return { forecastable: false, reason: "flat or negative trend" };

  return {
    forecastable: true,
    projectedAt: last.measuredAt + timeToSaturation,
    projectedRatio: 1.0,
  };
}
