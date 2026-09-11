import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const customFieldSchema = z.object({
  id: z.number().int(),
  entityType: z.string(),
  name: z.string(),
  label: z.string(),
  fieldType: z.string(),
  options: z.unknown().nullable(),
  isRequired: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const customFieldsListSchema = z.object({
  fields: z.array(customFieldSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const customFieldMutatedSchema = z.object({
  field: customFieldSchema,
});

export { successSchema };
