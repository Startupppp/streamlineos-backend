import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const apiTokenItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  isRevoked: z.boolean(),
  lastUsedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const apiTokensPageSchema = cursorPageSchema(apiTokenItemSchema);

export const apiTokenRowSchema = apiTokenItemSchema.extend({
  rawKey: z.string().optional(),
});

