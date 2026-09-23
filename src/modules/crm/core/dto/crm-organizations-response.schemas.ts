import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { crmAccountTierSchema } from "./organizations.schemas";

export const crmOrgSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  description: z.string().nullable(),
  tier: crmAccountTierSchema.nullable(),
  createdAt: wireDate(),
});

export const crmOrgWithOpenRequestsSchema = crmOrgSchema.extend({
  openRequestCount: z.number().int(),
});

export const crmOrgsListSchema = z.object({
  organizations: z.array(crmOrgWithOpenRequestsSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().optional(),
});

const potentialDuplicateSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  matchReason: z.enum(["domain", "name"]),
});

export const crmOrgCreatedSchema = crmOrgSchema.extend({
  possibleDuplicates: z.array(potentialDuplicateSchema),
});

const crmContactMirrorSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  organizationId: z.number().int().nullable(),
  leadId: z.number().int().nullable(),
  mergedIntoId: z.null(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  designation: z.string().nullable(),
  city: z.string().nullable(),
  website: z.string().nullable(),
});

export const crmOrgWithContactsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  parentId: z.number().int().nullable(),
  mergedIntoId: z.null(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  description: z.string().nullable(),
  tier: crmAccountTierSchema.nullable(),
  contacts: z.array(crmContactMirrorSchema),
});

export const crmOrgDuplicatePairSchema = z.object({
  items: z.array(
    z.object({
      org1: z.object({ id: z.number().int(), name: z.string(), domain: z.string().nullable() }),
      org2: z.object({ id: z.number().int(), name: z.string(), domain: z.string().nullable() }),
      matchReason: z.enum(["domain", "name"]),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const crmOrgPotentialDuplicatesSchema = z.array(potentialDuplicateSchema);
