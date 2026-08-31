export type PersistedMessage = {
  id: number;
  channelId: number;
  senderMembershipId: number | null;
  content: string | null;
  createdAt: Date;
  replyToId: number | null;
  metadata: Record<string, unknown> | null;
  messageType: "text" | "lead_submission" | "system";
};

export type { ChatAttachmentPayload } from "../realtime/dto/realtime.schemas";
