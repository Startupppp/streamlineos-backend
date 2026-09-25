import { z } from "zod";
import { KB_LINKED_DOCUMENT_VERSION_MODES } from "../../../../db/schema/kb/linked-documents";
import { audienceEntrySchema, MAX_DOCUMENT_AUDIENCES } from "./document-audience-entry.schema";

export const kbLinkParamsSchema = z.object({ documentId: z.coerce.number().int().positive() }).strict();

const audiencesField = z.array(audienceEntrySchema).max(MAX_DOCUMENT_AUDIENCES);

const pinConsistent = (value: { versionMode?: string; pinnedVersion?: number }): boolean =>
  value.versionMode === undefined ? value.pinnedVersion === undefined : (value.versionMode === "PINNED") === (value.pinnedVersion !== undefined);
const PIN_MESSAGE = { message: "A pinned entry names its version; an entry that follows the latest does not.", path: ["pinnedVersion"] };

export const publishLinkSchema = z
  .object({
    audiences: audiencesField.optional(),
    versionMode: z.enum(KB_LINKED_DOCUMENT_VERSION_MODES).optional(),
    pinnedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(pinConsistent, PIN_MESSAGE);
export type PublishLinkInput = z.infer<typeof publishLinkSchema>;

export const updateLinkSchema = z
  .object({
    audiences: audiencesField.optional(),
    versionMode: z.enum(KB_LINKED_DOCUMENT_VERSION_MODES).optional(),
    pinnedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(pinConsistent, PIN_MESSAGE)
  .refine((value) => value.audiences !== undefined || value.versionMode !== undefined, { message: "Nothing to change." });
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;

export const UNPUBLISH_REASON_MAX_LENGTH = 500;

export const unpublishLinkSchema = z.object({ reason: z.string().trim().min(1).max(UNPUBLISH_REASON_MAX_LENGTH).optional() }).strict().default({});
export type UnpublishLinkInput = z.infer<typeof unpublishLinkSchema>;
