import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

const partyRowSchema = z.object({
  partyId: z.string(),
  organizationId: z.string(),
  partyType: z.string(),
  partyKind: z.string().nullable(),
  name: z.string(),
  legalName: z.string().nullable(),
  displayName: z.string().nullable(),
  taxNumber: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  employerPartyId: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const partyPaginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int().optional(),
  totalPages: z.number().int().optional(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const partyListSchema = z.object({
  data: z.array(partyRowSchema),
  pagination: partyPaginationSchema,
});

export const partyDetailSchema = partyRowSchema;

const partyContactRowSchema = z.object({
  partyContactId: z.string(),
  organizationId: z.string(),
  partyId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  isPrimary: z.boolean(),
  customFields: z.record(z.string(), z.unknown()).nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const partyContactListSchema = z.array(partyContactRowSchema);
export const partyContactDetailSchema = partyContactRowSchema;

const divergentRowSchema = z.object({
  kind: z.string(),
  legacyId: z.number().int(),
  partyId: z.string(),
  fields: z.array(z.string()),
});

export const mirrorDivergenceSchema = z.object({
  checkedAt: z.string(),
  organizationId: z.string(),
  scanned: z.record(z.string(), z.number()),
  divergentCount: z.record(z.string(), z.number()),
  unmapped: z.record(z.string(), z.number()),
  divergent: z.array(divergentRowSchema),
  unexpressibleDeletions: z.array(z.record(z.string(), z.unknown())),
  employerDisagreements: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
  nextAfter: z.record(z.string(), z.number().nullable()),
});

export const partyRolesSchema = z.object({ roles: z.array(z.string()) });

export const detectResultSchema = z.object({
  autoMerged: z.array(
    z.object({
      survivorPartyId: z.string(),
      mergedPartyId: z.string(),
    }),
  ),
  queued: z.array(
    z.object({
      candidateId: z.string(),
      otherPartyId: z.string(),
      score: z.number(),
    }),
  ),
});

export const duplicateCandidatesSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});

export const dismissedSchema = z.object({ dismissed: z.literal(true) });

export const mergeOutcomeSchema = z.object({
  partyMergeId: z.string(),
  survivorPartyId: z.string(),
  mergedPartyId: z.string(),
  conflicts: z.record(
    z.string(),
    z.object({ kept: z.unknown(), discarded: z.unknown() }),
  ),
});

export const revertResultSchema = z.object({
  survivorPartyId: z.string(),
  restoredPartyId: z.string(),
});

const subjectFieldDefinitionSchema = z.object({
  name: z.string(),
  label: z.string(),
  kind: z.string(),
  required: z.boolean().optional(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        tone: z.string().optional(),
      }),
    )
    .optional(),
  hint: z.string().optional(),
});

const subjectTypeRowSchema = z.object({
  subjectTypeId: z.string(),
  organizationId: z.string(),
  key: z.string(),
  singular: z.string(),
  plural: z.string(),
  titleField: z.string(),
  fields: z.array(subjectFieldDefinitionSchema),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const subjectTypeListSchema = z.object({ data: z.array(subjectTypeRowSchema) });
export const subjectTypeDetailSchema = subjectTypeRowSchema;
export const subjectDeleteSchema = z.object({ deleted: z.literal(true) });

const subjectPartyLinkSchema = z.object({
  subjectPartyLinkId: z.string(),
  subjectId: z.string(),
  partyId: z.string(),
  organizationId: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
});

const subjectItemSchema = z.object({
  subjectId: z.string(),
  organizationId: z.string(),
  subjectTypeId: z.string(),
  title: z.string(),
  reference: z.string().nullable(),
  status: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()).nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const subjectListSchema = cursorPageSchema(subjectItemSchema);

export const subjectDetailSchema = subjectItemSchema.extend({
  parties: z.array(subjectPartyLinkSchema),
});

export const subjectRowSchema = subjectItemSchema;
export const subjectLinkSchema = subjectPartyLinkSchema;
export const subjectUnlinkSchema = z.object({ unlinked: z.literal(true) });
export const subjectForPartySchema = z.object({ data: z.array(subjectItemSchema) });
