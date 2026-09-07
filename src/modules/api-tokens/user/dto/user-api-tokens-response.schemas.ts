import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const userApiTokenItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: nullableWireDate(),
  lastUsedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const userApiTokensPageSchema = cursorPageSchema(userApiTokenItemSchema);

export const userApiTokenRowSchema = userApiTokenItemSchema.extend({
  rawToken: z.string().optional(),
});

const permissionItemSchema = z.object({
  name: z.string(),
  resource: z.string(),
  action: z.string(),
  description: z.string().optional(),
  scopable: z.boolean().optional(),
  baselineScope: z.string().optional(),
});

export const grantablePermissionsSchema = z.array(permissionItemSchema);
