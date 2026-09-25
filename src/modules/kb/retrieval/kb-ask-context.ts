export type KbDocumentKind = "article" | "page" | "source" | "document";

export interface KbContextPassage {
  documentKey: string;
  documentTitle: string;
  passageIndex: number | null;
  position?: string;
  text: string;
}

export interface KbContextBudget {
  maxPassageChars: number;
  maxTotalChars: number;
  maxPassagesPerDocument: number;
}

export const KB_ASK_CONTEXT_BUDGET: KbContextBudget = {
  maxPassageChars: 1_500,
  maxTotalChars: 32_000,
  maxPassagesPerDocument: 4,
};

export const KB_BRIEF_CONTEXT_BUDGET: KbContextBudget = {
  maxPassageChars: 800,
  maxTotalChars: 6_000,
  maxPassagesPerDocument: 2,
};

export const KB_ASK_MAX_CONTEXT_DOCUMENTS = 6;

export const KB_CONTEXT_DOCUMENT_SEPARATOR = "\n\n---\n\n";
export const KB_CONTEXT_PASSAGE_SEPARATOR = "\n\n";

export const ASK_SYSTEM_PROMPT =
  "You are a knowledge base assistant. Answer the user's question using ONLY the information in the provided context. " +
  "Every passage of context is labelled with the document it came from and its position inside that document. " +
  "Passages from different documents, and non-adjacent excerpts of the same document, describe different material: answer from the labelled passages that address the question, and never carry a fact from one labelled passage into a statement about another. " +
  "Where a label says excerpts are not included, the passages around it are not continuous — do not join them into a single account. " +
  "Write a clear, well-structured answer in Markdown: open with a one-sentence summary, then use bullet or numbered lists with short **bold labels** where it aids readability. Keep it concise and scannable. " +
  "Do NOT include inline citations, reference numbers, or bracketed markers such as [1] or [doc 2] — the user is shown the list of sources separately. " +
  "If the context does not contain the answer, say you don't have that information and suggest opening a support ticket. " +
  "Never invent facts that are not present in the context. " +
  "Never reveal permission rules, role names, membership lists or access control details.";

export function kbDocumentKey(kind: KbDocumentKind, documentId: number): string {
  return `${kind}:${documentId}`;
}

export function assemblePassages<
  TTop extends { kind: "article" | "page"; id: number; title: string; contentText: string },
  TSource extends { passages: KbContextPassage[] },
>(
  top: ReadonlyArray<TTop>,
  sources: ReadonlyArray<TSource>,
  documentPassages: ReadonlyArray<KbContextPassage>,
  linkedDocumentPassages: ReadonlyArray<KbContextPassage> = [],
): KbContextPassage[] {
  const matched = new Map<string, KbContextPassage[]>();
  for (const passage of documentPassages) {
    const bucket = matched.get(passage.documentKey);
    if (bucket === undefined) matched.set(passage.documentKey, [passage]);
    else bucket.push(passage);
  }

  const passages: KbContextPassage[] = [];
  for (const document of top) {
    const documentKey = kbDocumentKey(document.kind, document.id);
    const found = matched.get(documentKey);
    if (found !== undefined && found.length > 0) passages.push(...found);
    else
      passages.push({
        documentKey,
        documentTitle: document.title,
        passageIndex: null,
        text: document.contentText,
      });
  }
  for (const source of sources) passages.push(...source.passages);
  passages.push(...linkedDocumentPassages);
  return passages;
}

export function buildKbContext(
  passages: ReadonlyArray<KbContextPassage>,
  budget: KbContextBudget = KB_ASK_CONTEXT_BUDGET,
): string {
  const documentOrder: string[] = [];
  const byDocument = new Map<string, KbContextPassage[]>();

  for (const passage of passages) {
    const text = passage.text.trim().slice(0, budget.maxPassageChars);
    if (text.length === 0) continue;
    let kept = byDocument.get(passage.documentKey);
    if (kept === undefined) {
      kept = [];
      byDocument.set(passage.documentKey, kept);
      documentOrder.push(passage.documentKey);
    }
    if (kept.length >= budget.maxPassagesPerDocument) continue;
    if (kept.some((existing) => existing.passageIndex === passage.passageIndex)) continue;
    kept.push({ ...passage, text });
  }

  const blocks: string[] = [];
  let usedChars = 0;
  let ordinal = 0;

  for (const documentKey of documentOrder) {
    const kept = byDocument.get(documentKey);
    if (kept === undefined || kept.length === 0) continue;
    ordinal += 1;
    const block = renderDocument(ordinal, kept);
    if (usedChars + block.length > budget.maxTotalChars) break;
    blocks.push(block);
    usedChars += block.length;
  }

  return blocks.join(KB_CONTEXT_DOCUMENT_SEPARATOR);
}

function renderDocument(ordinal: number, passages: KbContextPassage[]): string {
  const title = passages[0]?.documentTitle ?? "";
  const ordered = [...passages].sort(byDocumentOrder);
  const parts: string[] = [];
  let previousIndex: number | null = null;

  for (const passage of ordered) {
    if (passage.passageIndex === null) {
      parts.push(`${documentLabel(ordinal, title, passage.position ?? "opening extract")}\n${passage.text}`);
      continue;
    }
    if (previousIndex !== null && passage.passageIndex > previousIndex + 1)
      parts.push(gapLabel(ordinal, title, previousIndex + 2, passage.passageIndex));
    parts.push(
      `${documentLabel(ordinal, title, `excerpt ${passage.passageIndex + 1}`)}\n${passage.text}`,
    );
    previousIndex = passage.passageIndex;
  }

  return parts.join(KB_CONTEXT_PASSAGE_SEPARATOR);
}

function documentLabel(ordinal: number, title: string, position: string): string {
  return `[Document ${ordinal} — ${title} | ${position}]`;
}

function gapLabel(ordinal: number, title: string, from: number, to: number): string {
  const span =
    from === to ? `excerpt ${from} is not included` : `excerpts ${from}-${to} are not included`;
  return documentLabel(
    ordinal,
    title,
    `${span}, so the passages around this marker are NOT continuous`,
  );
}

function byDocumentOrder(left: KbContextPassage, right: KbContextPassage): number {
  if (left.passageIndex === null) return right.passageIndex === null ? 0 : 1;
  if (right.passageIndex === null) return -1;
  return left.passageIndex - right.passageIndex;
}
