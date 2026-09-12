import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";
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
