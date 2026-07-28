const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "to", "of", "in", "on", "at", "by", "for",
  "with", "about", "from", "into", "through", "that", "this", "these", "those",
  "it", "its", "i", "you", "we", "they", "he", "she", "and", "or", "but", "if",
  "not", "no", "so", "as", "up", "out", "than", "then", "just", "only",
]);

function extractKeyTokens(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function sentenceOverlapRatio(sentence: string, contextChunks: string[]): number {
  const tokens = extractKeyTokens(sentence);
  if (tokens.length === 0) return 1;

  const contextText = contextChunks.join(" ").toLowerCase();
  const matched = tokens.filter((t) => contextText.includes(t));
  return matched.length / tokens.length;
}

export function scoreGrounding(
  output: string,
  context: string[],
): { grounded: boolean; unsupportedClaims: string[] } {
  if (!output.trim()) return { grounded: true, unsupportedClaims: [] };
  if (context.length === 0) return { grounded: false, unsupportedClaims: [output] };

  const sentences = output
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const unsupportedClaims: string[] = [];

  for (const sentence of sentences) {
    const ratio = sentenceOverlapRatio(sentence, context);
    if (ratio < 0.5) {
      unsupportedClaims.push(sentence);
    }
  }

  return { grounded: unsupportedClaims.length === 0, unsupportedClaims };
}
