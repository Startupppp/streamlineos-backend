import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const webFormFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const webFormSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fields: z.array(webFormFieldSchema),
  publicToken: z.string(),
  isActive: z.boolean(),
  submitMessage: z.string(),
  redirectUrl: z.string().nullable(),
  totalSubmissions: z.number().int(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
