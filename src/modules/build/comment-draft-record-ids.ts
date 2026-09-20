export function parseRecordIds(raw: string | null): number[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is number => typeof item === "number");
}
