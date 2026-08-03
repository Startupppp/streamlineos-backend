export function scoreCitations(
  citations: Array<{ id: string | number }>,
  retrievedIds: Set<string | number>,
): { valid: boolean; fabricated: Array<string | number> } {
  const fabricated = citations
    .map((c) => c.id)
    .filter((id) => !retrievedIds.has(id));

  return { valid: fabricated.length === 0, fabricated };
}
