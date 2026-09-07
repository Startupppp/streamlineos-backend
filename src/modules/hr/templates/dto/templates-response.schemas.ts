import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const cursorPagination = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const hrTemplateListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  kind: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  version: z.number().int(),
  parentTemplateId: z.number().int().nullable(),
  variablesUsed: z.array(z.string()),
  letterType: z.string().nullable(),
  createdBy: z.string(),
  updatedBy: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const hrTemplateRowSchema = hrTemplateListItemSchema.extend({
  content: z.record(z.string(), z.unknown()),
});

export const hrTemplateListSchema = z.object({
  data: z.array(hrTemplateListItemSchema),
  total: z.number().int(),
  pagination: cursorPagination,
});

export const hrTemplateSeedResultSchema = z.object({
  seeded: z.boolean(),
  count: z.number().int().optional(),
  message: z.string().optional(),
});

export const hrTemplateRenderResultSchema = z.object({
  outputHtml: z.string(),
  renderedSubject: z.string().optional(),
  renderId: z.number().int().optional(),
  templateVersion: z.number().int(),
});

const hrTemplateRenderRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  renderedForEmployeeId: z.number().int().nullable(),
  renderedBy: z.string(),
  contextSnapshot: z.record(z.string(), z.unknown()),
  outputHtml: z.string(),
  createdAt: wireDate(),
});

export const hrTemplateRendersListSchema = cursorPageSchema(hrTemplateRenderRowSchema);

export const templateVariableSchema = z.object({
  token: z.string(),
  label: z.string(),
  group: z.string(),
  sensitive: z.boolean(),
  example: z.string(),
});

export const templateVariablesListSchema = z.array(templateVariableSchema);
