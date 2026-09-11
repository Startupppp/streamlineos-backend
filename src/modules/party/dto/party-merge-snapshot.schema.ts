import { z } from "zod";

/**
 * The revert contract for a party merge.
 *
 * `party_merges.snapshot` is a jsonb column, so Drizzle types it
 * `Record<string, unknown>` and nothing about the value survives the round
 * trip. The write half (`party-merge.service.ts`) and the read half
 * (`party-revert.service.ts`) used to agree only by a pair of
 * `as unknown as` casts, which is the failure shape the ingress workflow
 * already retired: a row written by an older release deserialises into a lie
 * instead of raising, and the revert then reads `snapshot.movedContactIds`
 * off `undefined` after it has already rewritten both parties.
 *
 * One schema, parsed on read and inferred on write, is what makes the two
 * halves the same contract.
 */
export const legacyIdsByKindSchema = z.object({
  lead: z.array(z.number()),
  client: z.array(z.number()),
  contact: z.array(z.number()),
  organisation: z.array(z.number()).optional(),
});

const partySnapshotFieldsSchema = z.object({
  name: z.string().nullish(),
  legalName: z.string().nullish(),
  displayName: z.string().nullish(),
  taxNumber: z.string().nullish(),
  website: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  notes: z.string().nullish(),
  customFields: z.record(z.string(), z.unknown()).nullish(),
});

export const mergeSnapshotSchema = z.object({
  survivorBefore: partySnapshotFieldsSchema,
  mergedBefore: partySnapshotFieldsSchema,
  movedContactIds: z.array(z.string()).max(100),
  addedRoles: z.array(z.string()),
  movedIdentifierIds: z.array(z.string()).max(100).optional(),
  movedEmployeePartyIds: z.array(z.string()).max(100).optional(),
  movedLegacyIds: legacyIdsByKindSchema.optional(),
});

export type MergeSnapshot = z.infer<typeof mergeSnapshotSchema>;
