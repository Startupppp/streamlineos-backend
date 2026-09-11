import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const territoryRepSchema = z.object({
  id: z.number().int(),
  crmPersonId: z.number().int(),
  assignedAt: wireDate(),
});

export const territoryLocationSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  value: z.string(),
});

export const territorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  criteria: z.unknown(),
  priority: z.number().int(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  reps: z.array(territoryRepSchema),
  locations: z.array(territoryLocationSchema),
});

export const territoryPreviewSchema = z.object({
  matchedTerritory: z.unknown().nullable(),
  assignedReps: z.array(z.number().int()),
  assignedRepNames: z.array(z.string()),
});
