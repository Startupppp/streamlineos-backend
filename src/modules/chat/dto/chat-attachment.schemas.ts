import { z } from "zod";

export const chatAttachmentParamsSchema = z
  .object({
    channelId: z.coerce.number().int().positive(),
    attachmentId: z.coerce.number().int().positive(),
  })
  .strict();

export type ChatAttachmentParams = z.infer<typeof chatAttachmentParamsSchema>;
