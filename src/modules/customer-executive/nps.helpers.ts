export type NpsCategory = "promoter" | "passive" | "detractor";

export function categoryForScore(score: number): NpsCategory {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

export interface NpsBreakdown {
  promoters: number;
  passives: number;
  detractors: number;
  total: number;
}

export function npsBreakdown(categories: NpsCategory[]): NpsBreakdown {
  const breakdown: NpsBreakdown = { promoters: 0, passives: 0, detractors: 0, total: categories.length };
  for (const category of categories) {
    if (category === "promoter") breakdown.promoters += 1;
    else if (category === "passive") breakdown.passives += 1;
    else breakdown.detractors += 1;
  }
  return breakdown;
}

export function npsScore(breakdown: NpsBreakdown): number {
  if (breakdown.total === 0) return 0;
  return Math.round(((breakdown.promoters - breakdown.detractors) / breakdown.total) * 100);
}
