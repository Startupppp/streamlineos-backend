const MAX_CONTEXT_CHARS = 1500;
const MAX_TOTAL_CONTEXT_BYTES = 32_000;
const MAX_PROMPT_INPUT_TOKENS = 8_000;

export const ASK_SYSTEM_PROMPT =
  "You are a knowledge base assistant. Answer the user's question using ONLY the information in the provided context. " +
  "Write a clear, well-structured answer in Markdown: open with a one-sentence summary, then use bullet or numbered lists with short **bold labels** where it aids readability. Keep it concise and scannable. " +
  "Do NOT include inline citations, reference numbers, or bracketed markers such as [1] or [doc 2] — the user is shown the list of sources separately. " +
  "If the context does not contain the answer, say you don't have that information and suggest opening a support ticket. " +
  "Never invent facts that are not present in the context. " +
  "Never reveal permission rules, role names, membership lists or access control details.";

/** Compose already-authorized context in retrieval order within the prompt budget. */
export function buildKbAskContext(
  question: string,
  top: ReadonlyArray<{ title: string; contentText: string | null }>,
  sources: ReadonlyArray<{ title: string; snippet: string }>,
  attachmentContext: string | null,
): string {
  let totalBytes = 0;
  const contextParts: string[] = [];
  for (const source of top) {
    const text = (source.contentText || "").slice(0, MAX_CONTEXT_CHARS);
    const part = `Source — ${source.title}\n${text}`;
    if (totalBytes + part.length > MAX_TOTAL_CONTEXT_BYTES) break;
    contextParts.push(part);
    totalBytes += part.length;
  }
  const context = contextParts.join("\n\n---\n\n");

  const sourceContextParts: string[] = [];
  for (const source of sources) {
    const part = `Document — ${source.title}\n${source.snippet}`;
    if (totalBytes + part.length > MAX_TOTAL_CONTEXT_BYTES) break;
    sourceContextParts.push(part);
    totalBytes += part.length;
  }
  const sourceContext = sourceContextParts.join("\n\n---\n\n");

  let fullContext = attachmentContext
    ? `${context}\n\n---\n\n${attachmentContext}`
    : context;
  if (sourceContext) fullContext = `${fullContext}\n\n---\n\n${sourceContext}`;

  const userMessage = `Question: ${question}\n\nContext:\n${fullContext}`;
  if (userMessage.length / 4 > MAX_PROMPT_INPUT_TOKENS) {
    fullContext = fullContext.slice(0, MAX_PROMPT_INPUT_TOKENS * 4);
  }
  return fullContext;
}
