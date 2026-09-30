import { z } from "zod";
import { notificationCategoryEnum } from "../../../db/schema/common/enums";

/**
 * RT-001. A web push payload transits a third-party push service and renders on
 * lock screens and in OS notification history. It therefore carries NO record
 * content — no title, no body, no names, no amounts.
 *
 * There is deliberately no free-text field on this schema. `category` is the
 * pgEnum, so the only thing that can cross this boundary is a fixed label the
 * service worker maps to generic copy. Making the unsafe state unrepresentable
 * beats documenting a convention (§20) — a `body` field with a comment saying
 * "nothing sensitive here" is the version that eventually leaks.
 *
 * The client fetches the notification itself through the authenticated API, which
 * is where authorization already lives.
 */
export const pushPayloadSchema = z.object({
  category: z.enum(notificationCategoryEnum.enumValues).optional(),
  url: z.string().optional(),
  notificationId: z.number().int().positive().optional(),
  /** Stable client/provider deduplication identity for replayed durable fan-out. */
  idempotencyKey: z.string().min(1).optional(),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const chatAttachmentPayloadSchema = z.object({
  id: z.number(),
  fileName: z.string(),
  fileUrl: z.string(),
  fileKey: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
});

export const chatMessagePayloadSchema = z.object({
  id: z.number(),
  channelId: z.number(),
  senderId: z.string(),
  senderName: z.string().nullable(),
  senderImage: z.string().nullable().optional(),
  content: z.string().nullable(),
  createdAt: z.date(),
  replyToId: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  messageType: z.string().optional(),
  attachments: z.array(chatAttachmentPayloadSchema).optional(),
  /** Stable client-side deduplication identity for a replayed durable fan-out. */
  idempotencyKey: z.string().min(1).optional(),
  /** The sender's client-minted send key, so the sender's client can replace its optimistic copy. */
  clientKey: z.string().nullable().optional(),
});

export type ChatAttachmentPayload = z.infer<typeof chatAttachmentPayloadSchema>;
export type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;
