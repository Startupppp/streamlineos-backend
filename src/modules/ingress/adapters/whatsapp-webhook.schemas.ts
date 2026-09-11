import { z } from "zod";

const metadataSchema = z.object({
  display_phone_number: z.string().optional(),
  phone_number_id: z.string().optional(),
});

const profileSchema = z.object({ name: z.string().optional() }).optional();

const contactSchema = z.object({
  wa_id: z.string().optional(),
  profile: profileSchema,
});

/**
 * One file on a message, as every media type spells it.
 *
 * `filename` appears on documents only — the sender typed it — and no type
 * carries a size, which is why `decideAttachment` refuses WhatsApp media until
 * the separate media-metadata read is wired.
 */
const mediaSchema = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
});

const messageSchema = z.object({
  id: z.string().optional(),
  from: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.string().optional(),
  text: z.object({ body: z.string().optional() }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  context: z.object({ id: z.string().optional() }).optional(),
  /**
   * Read even though an inbound message never carries one.
   *
   * The conversation object belongs to delivery *statuses* on the Cloud API,
   * not to messages. It is picked up here so that a relay or a chat-shaped
   * provider that does supply one wins over the synthesised identity, which is
   * the correct precedence — and costs a field nobody has to fill in.
   */
  conversation: z.object({ id: z.string().optional() }).optional(),
});

const changeValueSchema = z.object({
  metadata: metadataSchema.optional(),
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const changeSchema = z.object({
  field: z.string().optional(),
  value: changeValueSchema.optional(),
});

export const webhookSchema = z.object({
  entry: z.array(z.object({ changes: z.array(changeSchema).optional() })).optional(),
});

export type RawMessage = z.infer<typeof messageSchema>;
export type RawContact = z.infer<typeof contactSchema>;
export type RawMedia = z.infer<typeof mediaSchema>;
