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

export interface MessageFanout {
  dispatch(input: FanoutInput): Promise<void>;
}

export interface FanoutDeferredTask {
  orgId: string;
  run(): Promise<void>;
}

export interface FanoutDeferralPort {
  defer(task: FanoutDeferredTask): void;
}

export const FANOUT_DEFERRAL_PORT = "FANOUT_DEFERRAL_PORT";
