type TipTapNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: unknown[];
  text?: string;
};

function walkNodes(node: unknown, visitor: (n: TipTapNode) => void): void {
  if (typeof node !== "object" || node === null) return;
  const n = node as TipTapNode;
  visitor(n);
  if (Array.isArray(n.content)) {
    for (const child of n.content) walkNodes(child, visitor);
  }
}

export function extractPageLinkIds(content: unknown): number[] {
  const ids: number[] = [];
  try {
    walkNodes(content, (node) => {
      if (node.type === "pageLink" && typeof node.attrs?.pageId === "number") {
        ids.push(node.attrs.pageId);
      }
    });
  } catch {
  }
  return [...new Set(ids)];
}

export function extractMentionUserIds(content: unknown): string[] {
  const ids: string[] = [];
  try {
    walkNodes(content, (node) => {
      if (node.type === "mention" && typeof node.attrs?.id === "string" && node.attrs.id.length > 0) {
        ids.push(node.attrs.id);
      }
    });
  } catch {
  }
  return [...new Set(ids)];
}
