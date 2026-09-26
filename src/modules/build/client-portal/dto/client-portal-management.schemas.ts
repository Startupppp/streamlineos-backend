import { z } from "zod";

export const publishPortalSchema = z.object({}).strict();
export const unpublishPortalSchema = z.object({}).strict();

export type PublishPortalInput = z.infer<typeof publishPortalSchema>;
export type UnpublishPortalInput = z.infer<typeof unpublishPortalSchema>;
