import { Logger } from "@nestjs/common";

const logger = new Logger("KbPageContent");

type TipTapNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: unknown[];
  text?: string;
};

type SlateNode = {
  type?: string;
  children?: SlateNode[];
  pageId?: number;
  userId?: string;
  key?: unknown;
  [key: string]: unknown;
};

function isSlateNode(value: unknown): value is SlateNode {
  return typeof value === "object" && value !== null;
}

function walkNodes(node: unknown, visitor: (n: TipTapNode) => void): void {
  if (typeof node !== "object" || node === null) return;
  const n = node as TipTapNode;
  visitor(n);
  if (Array.isArray(n.content)) {
    for (const child of n.content) walkNodes(child, visitor);
  }
}

function walkSlateNodes(nodes: unknown[], visitor: (node: SlateNode) => void): void {
  for (const item of nodes) {
    if (!isSlateNode(item)) continue;
    visitor(item);
    if (Array.isArray(item.children)) {
      walkSlateNodes(item.children, visitor);
    }
  }
}

export function extractPageLinkIds(content: unknown): number[] {
  const ids: number[] = [];
  try {
    if (Array.isArray(content)) {
      walkSlateNodes(content, (node) => {
        if (node.type === "page_link" && typeof node.pageId === "number") {
          ids.push(node.pageId);
        }
      });
    } else {
      walkNodes(content, (node) => {
        if (node.type === "pageLink" && typeof node.attrs?.pageId === "number") {
          ids.push(node.attrs.pageId);
        }
      });
    }
  } catch (err) {
    logger.warn(`extractPageLinkIds parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [...new Set(ids)];
}

export function extractMentionUserIds(content: unknown): string[] {
  const ids: string[] = [];
  try {
    if (Array.isArray(content)) {
      walkSlateNodes(content, (node) => {
        if (node.type === "mention") {
          const id = typeof node.key === "string" && node.key.length > 0
            ? node.key
            : typeof node.userId === "string" && node.userId.length > 0
              ? node.userId
              : null;
          if (id) ids.push(id);
        }
      });
    } else {
      walkNodes(content, (node) => {
        if (node.type === "mention" && typeof node.attrs?.id === "string" && node.attrs.id.length > 0) {
          ids.push(node.attrs.id);
        }
      });
    }
  } catch (err) {
    logger.warn(`extractMentionUserIds parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [...new Set(ids)];
}
