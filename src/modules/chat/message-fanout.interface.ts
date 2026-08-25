import type { ChatAttachmentPayload, PersistedMessage } from "./chat-message.types";

export interface FanoutInput {
  orgId: string;
  channelId: number;
  channelType: string | null;
  message: PersistedMessage;
  content: string | null;
  mentionedUserIds: string[] | undefined;
  attachments: ChatAttachmentPayload[];
  strippedMetadata: Record<string, unknown> | null;
  senderName: string | null;
  senderImage: string | null;
}

/**
 * Stable identity for one logical fan-out effect. The outbox event id is preferred by the
 * queued consumer; the message identity is the fallback used by the post-commit realtime hook.
 * Downstream adapters must forward this key to providers/clients and must not generate a new one
 * on retry. Delivery remains at-least-once across a crash between an external send and inbox
 * completion; providers that support deduplication can use this key to close that window.
 */
export interface FanoutDeliveryContext {
  idempotencyKey: string;
  producerEventId?: string;
}

export interface MessageFanoutProvider {
  dispatchRealtime(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void>;
  dispatchDeferred(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void>;
}

export const MESSAGE_FANOUT_PROVIDER = Symbol("MESSAGE_FANOUT_PROVIDER");

export function messageFanoutIdempotencyKey(input: FanoutInput): string {
  return `chat-message:${input.orgId}:${input.message.id}`;
}
