import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const issueFieldSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
  editable: z.boolean().optional(),
});

const issueLayoutSchema = z.object({
  key: z.string(),
  recordType: z.string(),
  singular: z.string(),
  plural: z.string(),
  titleField: z.string(),
  fields: z.array(issueFieldSpecSchema),
  list: z.object({
    searchPlaceholder: z.string(),
    columns: z.array(z.string()),
  }),
  detail: z.record(z.string(), z.unknown()),
  form: z.record(z.string(), z.unknown()),
});

export const issueRecordTypesSchema = z.object({
  recordTypes: z.array(issueLayoutSchema),
});

const issueRecordRowSchema = z.object({
  issueRecordId: z.string(),
  recordType: z.string(),
  title: z.string(),
  severity: z.string(),
  stage: z.string(),
  ownerUserId: z.string().nullable(),
  partyId: z.string().nullable(),
  partyName: z.string().nullable(),
  dealId: z.number().int().nullable(),
  dealTitle: z.string().nullable(),
  dueAt: z.string().nullable(),
  openedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  ageDays: z.number(),
  details: z.string().nullable(),
  reference: z.string().nullable(),
});

const issueTransitionSchema = z.object({
  issueStageTransitionId: z.string(),
  fromStage: z.string().nullable(),
  toStage: z.string(),
  actorKind: z.string(),
  actorLabel: z.string().nullable(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  occurredAt: wireDate(),
});

export const issueListResponseSchema = z.object({
  layout: issueLayoutSchema,
  data: z.array(issueRecordRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const issueDetailSchema = z.object({
  layout: issueLayoutSchema,
  record: issueRecordRowSchema,
  transitions: z.array(issueTransitionSchema),
});

export const issueTransitionsListSchema = z.array(issueTransitionSchema);

export const issueTransitionResultSchema = z.object({
  issueRecordId: z.string(),
  fromStage: z.string().nullable(),
  toStage: z.string(),
  issueStageTransitionId: z.string().nullable(),
});
