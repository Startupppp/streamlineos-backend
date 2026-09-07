import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { signEnvelopeRowSchema } from "./e-sign-envelopes-response.schemas";

export const signTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  status: z.enum(["draft", "published", "archived"]),
  ownerMembershipId: z.number().int().nullable(),
  version: z.number().int(),
  templateJson: z.record(z.string(), z.unknown()),
  restrictedToRoles: z.array(z.string()),
  restrictedToTeams: z.array(z.string()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const templateMutationResponseSchema = signTemplateRowSchema;

export const listTemplatesResponseSchema = z.array(signTemplateRowSchema);

export const instantiateTemplateResponseSchema = signEnvelopeRowSchema;

export const signPublicFormRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int(),
  slug: z.string(),
  accessCodeHash: z.string().nullable(),
  maxSubmissions: z.number().int().nullable(),
  submissionCount: z.number().int(),
  expiresAt: nullableWireDate(),
  completionRedirectUrl: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  embedAllowed: z.boolean(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const publishPublicFormResponseSchema = signPublicFormRowSchema;
