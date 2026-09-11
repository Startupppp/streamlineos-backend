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

/** One side of a candidate pair, projected from `business_parties` by the join. */
const duplicateSideSchema = z.object({
  partyId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  partyKind: z.string().nullable(),
  createdAt: wireDate(),
});

/**
 * `GET /party/duplicates`. The rows AND the page they came from.
 *
 * This was `{ data: z.array(z.record(z.string(), z.unknown())) }` — a contract
 * that described neither the row nor the envelope. The handler has always
 * returned `pagination` beside `data` (`PartyRolesService.listCandidates` runs
 * the page and a `count()` together), and the route takes `page`/`limit`, so
 * the omission left a paginated endpoint advertising no way to know when to
 * stop: `check:envelope-consistency` reported it as "no recognizable pagination
 * signal". Declaring what the handler already sends is the whole fix — the wire
 * does not move.
 *
 * `score` is `double precision`, not a numeric string. `signals`/`blockers` are
 * jsonb `string[]` columns the service defaults to `[]` when null, so neither is
 * nullable here.
 */
export const duplicateCandidatesSchema = z.object({
  data: z.array(
    z.object({
      candidateId: z.string(),
      score: z.number(),
      signals: z.array(z.string()),
      blockers: z.array(z.string()),
      status: z.string(),
      detectedAt: wireDate(),
      left: duplicateSideSchema,
      right: duplicateSideSchema,
    }),
  ),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
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

/**
 * The merge log, which exists to be acted on: every row is a revert control.
 *
 * `conflictFields` is the keys only — the discarded values stay in the snapshot
 * as evidence for an audit reader rather than going on a list. `mergedName` is
 * read out of that snapshot, so it is `""` for a merge filed before the
 * snapshot carried one rather than absent.
 */
export const partyMergeListSchema = z.object({
  data: z.array(z.object({
    partyMergeId: z.string(),
    survivorPartyId: z.string(),
    survivorName: z.string(),
    mergedPartyId: z.string(),
    mergedName: z.string(),
    decidedBy: z.string(),
    decidedByUserId: z.string().nullable(),
    confidence: z.number().nullable(),
    conflictFields: z.array(z.string()),
    mergedAt: wireDate(),
    revertedAt: nullableWireDate(),
  })),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
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
