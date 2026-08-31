import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const INBOX_KINDS = [
  "notification",
  "broadcast",
  "mail",
  "build_approval",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const unifiedInboxQuerySchema = z
  .object({
    limit: pageSizeField(25),
    cursor: z.string().min(1).optional(),
    kinds: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? (v
              .split(",")
              .map((k) => k.trim())
              .filter((k): k is InboxKind =>
                INBOX_KINDS.includes(k as InboxKind),
              ) as InboxKind[])
          : undefined,
      ),
    unreadOnly: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
  })
  .strict();

export type UnifiedInboxQuery = z.infer<typeof unifiedInboxQuerySchema>;

export type InboxActor = {
  id: string;
  name: string | null;
  image: string | null;
};

type InboxItemBase = {
  sourceModule: string;
  actor: InboxActor | null;
  subject: string;
  timestamp: string;
  isRead: boolean;
  deepLink: string | null;
  dedupKey: string;
};

export type NotificationInboxItem = InboxItemBase & {
  kind: "notification";
  id: number;
  notifType: string;
  priority: string;
  category: string;
  eventKey: string | null;
  body: string;
  pinned: boolean;
};

export type BroadcastInboxItem = InboxItemBase & {
  kind: "broadcast";
  id: number;
  notifType: string;
  priority: string;
  category: string;
  body: string;
};

export type MailInboxItem = InboxItemBase & {
  kind: "mail";
  id: string;
  threadId: string | null;
  accountId: number;
  snippet: string;
  hasAttachments: boolean;
};

export type BuildApprovalInboxItem = InboxItemBase & {
  kind: "build_approval";
  id: number;
  status: string;
  projectId: number;
  ticketId: number | null;
  dueAt: string | null;
};

export type UnifiedInboxItem =
  | NotificationInboxItem
  | BroadcastInboxItem
  | MailInboxItem
  | BuildApprovalInboxItem;

export type SourceStatus = {
  kind: InboxKind;
  included: boolean;
  reason: string | null;
};

export type UnifiedInboxResponse = {
  items: UnifiedInboxItem[];
  hasMore: boolean;
  nextCursor: string | null;
  sources: SourceStatus[];
};

export type InboxCursorState = {
  n: number | null;
  b: number | null;
  m: string | null;
  a: number | null;
};

const EMPTY_CURSOR: InboxCursorState = { n: null, b: null, m: null, a: null };

export function encodeInboxCursor(state: InboxCursorState): string {
  const payload: InboxCursorState = {
    n: typeof state.n === "number" ? state.n : null,
    b: typeof state.b === "number" ? state.b : null,
    m: typeof state.m === "string" ? state.m : null,
    a: typeof state.a === "number" ? state.a : null,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeInboxCursor(
  cursor: string | undefined | null,
): InboxCursorState {
  if (typeof cursor !== "string" || cursor.length === 0) return EMPTY_CURSOR;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    )
      return EMPTY_CURSOR;
    const obj = parsed as Record<string, unknown>;
    return {
      n: typeof obj["n"] === "number" ? obj["n"] : null,
      b: typeof obj["b"] === "number" ? obj["b"] : null,
      m: typeof obj["m"] === "string" ? obj["m"] : null,
      a: typeof obj["a"] === "number" ? obj["a"] : null,
    };
  } catch {
    return EMPTY_CURSOR;
  }
}
