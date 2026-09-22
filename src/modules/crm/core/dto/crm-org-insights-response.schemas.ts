import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const orgHierarchyNodeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  industry: z.string().nullable(),
  healthScore: z.number().nullable(),
  parentId: z.number().int().nullable(),
  get children() {
    return z.array(orgHierarchyNodeSchema);
  },
});


export const orgRollupSchema = z.object({
  totalContacts: z.number().int(),
  totalDeals: z.number().int(),
  openDeals: z.number().int(),
  totalDealValue: z.number(),
  totalLeads: z.number().int(),
});

export const orgTimelineEventSchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.enum(["contact_created", "deal_created", "lead_linked", "note_added"]),
  description: z.string(),
  entityId: z.number().int(),
});

export const orgTimelineSchema = z.array(orgTimelineEventSchema);

export const orgRelatedLeadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  company: z.string().nullable(),
  source: z.string(),
  createdAt: wireDate(),
});

export const orgRelatedLeadsSchema = z.array(orgRelatedLeadSchema);

export const orgMergeResultSchema = z.object({
  success: z.literal(true),
  survivorId: z.number().int(),
  mergedId: z.number().int(),
  partyMergeId: z.string(),
  conflicts: z.unknown(),
});
