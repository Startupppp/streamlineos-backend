import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { chatMessageSchema, chatAttachmentSchema } from "./chat-messages-response.schemas";

const chatOkSchema = z.object({ ok: z.literal(true) });

const chatHuddleParticipantSchema = z.object({
  id: z.number().int(),
  huddleId: z.number().int(),
  joinedAt: wireDate(),
  leftAt: nullableWireDate(),
  isMuted: z.boolean(),
  handRaised: z.boolean(),
  isScreenSharing: z.boolean(),
  channelId: z.number().int(),
  userId: z.string().nullable(),
  role: z.string(),
  lastReadAt: nullableWireDate(),
  isFavorite: z.boolean(),
  notificationPreference: z.string(),
  archivedAt: nullableWireDate(),
  user: z
    .object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() })
    .nullable(),
});

export const huddleWireSchema = z.object({
  id: z.number().int(),
  channelId: z.number().int(),
  status: z.string(),
  calendarEventId: z.string().nullable(),
  startedAt: nullableWireDate(),
  endedAt: nullableWireDate(),
  startedBy: z.string().nullable(),
  startedByUser: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  participants: z.array(chatHuddleParticipantSchema),
});

export const huddleWireNullableSchema = huddleWireSchema.nullable();

const pinnedMessageSenderSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const pinnedMessageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  content: z.string().nullable(),
  replyToId: z.number().int().nullable(),
  isEdited: z.boolean(),
  isDeleted: z.boolean(),
  messageType: z.string(),
  channelPosition: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  senderId: z.string().nullable(),
  sender: pinnedMessageSenderSchema.nullable(),
  reactions: z.record(z.string(), z.array(z.string())),
  attachments: z.array(chatAttachmentSchema),
});

export const chatPinItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  messageId: z.number().int(),
  pinnedByMembershipId: z.number().int().nullable(),
  pinnedAt: wireDate(),
  pinnedBy: z.string().nullable(),
  pinnedByUser: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  message: pinnedMessageSchema,
});

export const chatPinsListResponseSchema = z.array(chatPinItemSchema);

const savedMessageItemSchema = chatMessageSchema.extend({
  channel: z
    .object({ id: z.number().int(), name: z.string(), type: z.string() })
    .nullable()
    .optional(),
});

export const chatSavedListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      orgId: z.string(),
      membershipId: z.number().int(),
      messageId: z.number().int(),
      savedAt: wireDate(),
      message: savedMessageItemSchema,
    }),
  ),
  nextCursor: z.number().int().optional(),
});

export const chatInviteLinkTokenSchema = z.object({ token: z.string() });

export const chatInviteLinkJoinSchema = z.object({
  ok: z.literal(true),
  channelId: z.number().int(),
});

export const chatSummarizeResponseSchema = z.object({ summary: z.string() });

export const chatAblyTokenSchema = z.object({
  keyName: z.string(),
  timestamp: z.number().int(),
  nonce: z.string(),
  mac: z.string(),
  clientId: z.string().optional(),
  capability: z.string().optional(),
  ttl: z.number().int().optional(),
});

export const chatLinkPreviewSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
});

export const chatSignedUrlSchema = z.object({ url: z.string() });

const entityReferenceSchema = z.object({
  type: z.string(),
  id: z.string(),
});

const entityActionOptionSourceSchema = z.object({
  from: entityReferenceSchema,
});

const entityActionInputSchema = z.object({
  name: z.string(),
  kind: z.enum(["text", "date", "user", "choice"]),
  required: z.boolean(),
  choices: z.array(z.string()).optional(),
  options: entityActionOptionSourceSchema.optional(),
});

const entityActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  inputs: z.array(entityActionInputSchema),
});

export const chatAvailableActionsSchema = z.object({
  references: z.array(
    z.object({
      reference: entityReferenceSchema,
      actions: z.array(entityActionSchema),
    }),
  ),
});

export const chatActionOptionsSchema = z.object({
  options: z.array(z.record(z.string(), z.unknown())),
});

export const chatSubmitActionSchema = z.object({
  success: z.literal(true),
});

export const chatCreateTaskSchema = z.object({
  ticketId: z.number().int(),
  ticketNumber: z.number().int(),
});

const presenceMessageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  content: z.string().nullable(),
  replyToId: z.number().int().nullable(),
  isEdited: z.boolean(),
  isDeleted: z.boolean(),
  messageType: z.string(),
  channelPosition: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  senderMembership: z
    .object({
      id: z.number().int(),
      user: z
        .object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
  channel: z
    .object({ id: z.number().int(), name: z.string(), type: z.string() })
    .nullable(),
});

export const chatPresenceSearchResponseSchema = z.array(presenceMessageSchema);

const searchMessageItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  content: z.string().nullable(),
  isEdited: z.boolean(),
  isDeleted: z.boolean(),
  messageType: z.string(),
  channelPosition: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  senderId: z.string().nullable(),
  sender: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable(),
  reactions: z.record(z.string(), z.array(z.string())),
  attachments: z.array(chatAttachmentSchema),
  channel: z.object({ id: z.number().int(), name: z.string(), type: z.string() }).nullable(),
});

export const chatSearchMessagesResponseSchema = z.object({
  results: z.array(searchMessageItemSchema),
  nextCursor: z.number().int().optional(),
});

export const chatSearchChannelsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    type: z.string(),
    description: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    isMember: z.boolean(),
  }),
);

export const chatSearchUsersResponseSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
);

export { chatOkSchema };
