import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const signFieldRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  documentId: z.number().int(),
  recipientId: z.number().int(),
  fieldType: z.enum(["signature", "initials", "date_signed", "text", "multiline", "email", "name", "company", "title", "checkbox", "radio", "dropdown", "attachment", "stamp", "strikethrough", "readonly_merge"]),
  label: z.string().nullable(),
  pageNumber: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  required: z.boolean(),
  readonly: z.boolean(),
  orderIndex: z.number().int(),
  groupId: z.string().nullable(),
  defaultValue: z.string().nullable(),
  optionsJson: z.array(z.string()).nullable(),
  validationType: z.string().nullable(),
  validationRulesJson: z.record(z.string(), z.unknown()).nullable(),
  conditionalRulesJson: z.record(z.string(), z.unknown()).nullable(),
  valueJson: z.record(z.string(), z.unknown()).nullable(),
  attachmentFileKey: z.string().nullable(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const fieldMutationResponseSchema = signFieldRowSchema;

export const listFieldsResponseSchema = z.array(signFieldRowSchema);
