import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import {
  DOCUMENT_AUDIENCE_KINDS,
  KB_LINKED_DOCUMENT_STATUSES,
  KB_LINKED_DOCUMENT_VERSION_MODES,
} from "../../../../db/schema/kb/linked-documents";

const audienceSchema = z.object({
  kind: z.enum(DOCUMENT_AUDIENCE_KINDS),
  refId: z.string().nullable(),
  label: z.string().nullable(),
});

const linkSchema = z.object({
  id: z.number().int(),
  status: z.enum(KB_LINKED_DOCUMENT_STATUSES),
  versionMode: z.enum(KB_LINKED_DOCUMENT_VERSION_MODES),
  pinnedVersion: z.number().int().nullable(),
  audiences: z.array(audienceSchema),
  publishedAt: wireDate(),
  unpublishedAt: nullableWireDate(),
  unpublishReason: z.string().nullable(),
  newerVersionAvailable: z.boolean(),
});

const blockerSchema = z.object({
  code: z.enum(["CLASSIFICATION_NOT_SHAREABLE", "BELONGS_TO_AN_EMPLOYEE", "TYPE_NOT_ALLOWED", "DOCUMENT_INACTIVE", "HIRING_ARTEFACT", "METADATA_HOLDS_PERSONAL_IDENTIFIER"]),
  message: z.string(),
});

export const kbLinkStateResponseSchema = z.object({
  documentId: z.number().int(),
  link: linkSchema.nullable(),
  publishable: z.boolean(),
  blockers: z.array(blockerSchema),
  documentAudiences: z.array(audienceSchema),
});
export type KbLinkState = z.infer<typeof kbLinkStateResponseSchema>;
