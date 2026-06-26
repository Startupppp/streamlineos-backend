export function sanitizeText(text: string): string {
  return text.replace(/^[=+\-@\t\r]+/, "");
}

export type NpsCategory = "promoter" | "passive" | "detractor";

export function categoryForScore(score: number): NpsCategory {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}
