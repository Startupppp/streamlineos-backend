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
          ? v
              .split(",")
              .map((k) => k.trim())
              .filter((k): k is InboxKind =>
                INBOX_KINDS.some((kind) => kind === k),
              )
          : undefined,
      ),
    unreadOnly: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
    q: z.string().max(200).trim().optional(),
    category: z.string().optional(),
    priority: z.string().optional(),
    triage: z.enum(["active", "later", "done"]).optional(),
  })
  .strict();

export type UnifiedInboxQuery = z.infer<typeof unifiedInboxQuerySchema>;

export const inboxActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

export type InboxActor = z.infer<typeof inboxActorSchema>;

const inboxItemBaseFields = {
  sourceModule: z.string(),
  actor: inboxActorSchema.nullable(),
  subject: z.string(),
  timestamp: z.string(),
  isRead: z.boolean(),
  deepLink: z.string().nullable(),
  dedupKey: z.string(),
};

export const notificationInboxItemSchema = z.object({
  kind: z.literal("notification"),
  id: z.number().int(),
  notifType: z.string(),
  priority: z.string(),
  category: z.string(),
  eventKey: z.string().nullable(),
  body: z.string(),
  pinned: z.boolean(),
  ...inboxItemBaseFields,
});

export const broadcastInboxItemSchema = z.object({
  kind: z.literal("broadcast"),
  id: z.number().int(),
  notifType: z.string(),
  priority: z.string(),
  category: z.string(),
  body: z.string(),
  ...inboxItemBaseFields,
});

export const mailInboxItemSchema = z.object({
  kind: z.literal("mail"),
  id: z.string(),
  threadId: z.string().nullable(),
  accountId: z.number().int(),
  snippet: z.string(),
  hasAttachments: z.boolean(),
  ...inboxItemBaseFields,
});

export const buildApprovalInboxItemSchema = z.object({
  kind: z.literal("build_approval"),
  id: z.number().int(),
  status: z.string(),
  projectId: z.number().int().nullable(),
  approvalKind: z.string(),
  ticketId: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  ...inboxItemBaseFields,
});

export const unifiedInboxItemSchema = z.discriminatedUnion("kind", [
  notificationInboxItemSchema,
  broadcastInboxItemSchema,
  mailInboxItemSchema,
  buildApprovalInboxItemSchema,
]);

export type NotificationInboxItem = z.infer<typeof notificationInboxItemSchema>;
export type BroadcastInboxItem = z.infer<typeof broadcastInboxItemSchema>;
export type MailInboxItem = z.infer<typeof mailInboxItemSchema>;
export type BuildApprovalInboxItem = z.infer<
  typeof buildApprovalInboxItemSchema
>;
export type UnifiedInboxItem = z.infer<typeof unifiedInboxItemSchema>;

export const sourceStatusSchema = z.object({
  kind: z.enum(INBOX_KINDS),
  included: z.boolean(),
  reason: z.string().nullable(),
  available: z.boolean(),
  error: z.string().nullable(),
});

export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const unifiedInboxResponseSchema = z.object({
  items: z.array(unifiedInboxItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  sources: z.array(sourceStatusSchema),
  degraded: z.boolean(),
});

export type UnifiedInboxResponse = z.infer<typeof unifiedInboxResponseSchema>;

export const unifiedCountResponseSchema = z.object({
  notification: z.number().int(),
  mail: z.number().int(),
  approval: z.number().int(),
  total: z.number().int(),
  mailExact: z.boolean(),
});

export type UnifiedUnreadCount = z.infer<typeof unifiedCountResponseSchema>;

export type InboxSourcePosition = { id: number; t: string | null };

export type InboxCursorState = {
  n: number | null;
  nt: string | null;
  b: number | null;
  bt: string | null;
  m: string | null;
  a: number | null;
  at: string | null;
  ap: Record<string, InboxSourcePosition>;
};

const EMPTY_CURSOR: InboxCursorState = {
  n: null,
  nt: null,
  b: null,
  bt: null,
  m: null,
  a: null,
  at: null,
  ap: {},
};

function emptyInboxCursor(): InboxCursorState {
  return { ...EMPTY_CURSOR, ap: {} };
}

export function inboxSourcePosition(
  id: number | null,
  t: string | null,
): InboxSourcePosition | null {
  return id === null ? null : { id, t };
}

function sameAdapterPositions(
  left: Record<string, InboxSourcePosition>,
  right: Record<string, InboxSourcePosition>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const l = left[key];
    const r = right[key];
    return r !== undefined && l !== undefined && l.id === r.id && l.t === r.t;
  });
}

export function sameInboxCursorState(
  left: InboxCursorState,
  right: InboxCursorState,
): boolean {
  return (
    left.n === right.n &&
    left.nt === right.nt &&
    left.b === right.b &&
    left.bt === right.bt &&
    left.m === right.m &&
    left.a === right.a &&
    left.at === right.at &&
    sameAdapterPositions(left.ap, right.ap)
  );
}

export function encodeInboxCursor(state: InboxCursorState): string {
  const payload: InboxCursorState = {
    n: typeof state.n === "number" ? state.n : null,
    nt: typeof state.nt === "string" ? state.nt : null,
    b: typeof state.b === "number" ? state.b : null,
    bt: typeof state.bt === "string" ? state.bt : null,
    m: typeof state.m === "string" ? state.m : null,
    a: typeof state.a === "number" ? state.a : null,
    at: typeof state.at === "string" ? state.at : null,
    ap: decodeAdapterPositions(state.ap),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAdapterPositions(
  value: unknown,
): Record<string, InboxSourcePosition> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, InboxSourcePosition> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainRecord(entry)) continue;
    const id: unknown = entry["id"];
    const t: unknown = entry["t"];
    if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
    if (typeof t !== "string" && t !== null) continue;
    out[key] = { id, t };
  }
  return out;
}

export function decodeInboxCursor(
  cursor: string | undefined | null,
): InboxCursorState {
  if (typeof cursor !== "string" || cursor.length === 0)
    return emptyInboxCursor();
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return emptyInboxCursor();
    return {
      n: typeof parsed["n"] === "number" ? parsed["n"] : null,
      nt: typeof parsed["nt"] === "string" ? parsed["nt"] : null,
      b: typeof parsed["b"] === "number" ? parsed["b"] : null,
      bt: typeof parsed["bt"] === "string" ? parsed["bt"] : null,
      m: typeof parsed["m"] === "string" ? parsed["m"] : null,
      a: typeof parsed["a"] === "number" ? parsed["a"] : null,
      at: typeof parsed["at"] === "string" ? parsed["at"] : null,
      ap: decodeAdapterPositions(parsed["ap"]),
    };
  } catch {
    return emptyInboxCursor();
  }
}
